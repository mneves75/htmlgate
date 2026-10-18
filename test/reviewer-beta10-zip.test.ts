// Independent review of beta.10 (plans 008-010), Worker-free. Written from the requirements, with its own zip builder
// (not the CLI's writeZip) and zips made by tools installed on the machine (Info-ZIP, ditto, bsdtar, Python).
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterAll, describe, expect, test } from "vitest";
import { parseExpires } from "../packages/cli/src/files";
import { readConfig } from "../src/config";
import { importTicketKey, openTicket, sealTicket } from "../src/ticket";
import { entryStream, readSite, siteRequestPath, SiteError, type SiteEntry } from "../src/zip";

const enc = new TextEncoder();
const work = mkdtempSync(join(tmpdir(), "reviewer-beta10-zip-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

// ---------- a zip builder that can lie ----------
interface E {
  name: string;
  data?: Uint8Array | string;
  method?: 0 | 8;
  rawBody?: Uint8Array; // the stored bytes, when they must not be data's deflate
  crc?: number;
  size?: number; // declared (central) size
  csize?: number; // declared (central) compressed size
  mode?: number; // unix mode (with type bits)
  madeBy?: number;
  flags?: number;
  localName?: string;
  pointAt?: number; // central directory offset taken from entry #n's local header
  pointAtAbs?: number; // or an absolute offset
}
function build(entries: E[], o: { gap?: Uint8Array; comment?: Uint8Array; leading?: Uint8Array; count?: number } = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  const cds: Uint8Array[] = [];
  const offsets: number[] = [];
  let at = 0;
  const lead = o.leading ?? new Uint8Array();
  parts.push(lead);
  at += lead.length;
  for (const e of entries) {
    const data = typeof e.data === "string" ? enc.encode(e.data) : (e.data ?? new Uint8Array());
    const method = e.method ?? 0;
    const body = e.rawBody ?? (method === 8 ? deflateRawSync(data) : data);
    const name = enc.encode(e.name);
    const lname = enc.encode(e.localName ?? e.name);
    const crc = e.crc ?? crc32(data);
    const csize = e.csize ?? body.length;
    const size = e.size ?? data.length;
    const flags = e.flags ?? 0x0800;
    const local = new Uint8Array(30 + lname.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, lname.length, true);
    local.set(lname, 30);
    local.set(body, 30 + lname.length);
    offsets.push(at);
    at += local.length;
    parts.push(local);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, ((e.madeBy ?? 3) << 8) | 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, csize, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, ((e.mode ?? 0o100644) << 16) >>> 0, true);
    cd.set(name, 46);
    cds.push(cd);
  }
  entries.forEach((e, i) => {
    new DataView(cds[i]!.buffer).setUint32(42, e.pointAtAbs ?? (e.pointAt !== undefined ? offsets[e.pointAt]! : offsets[i]!), true);
  });
  const cdStart = at;
  for (const cd of cds) {
    parts.push(cd);
    at += cd.length;
  }
  const cdSize = at - cdStart;
  if (o.gap) {
    parts.push(o.gap);
    at += o.gap.length;
  }
  const comment = o.comment ?? new Uint8Array();
  const end = new Uint8Array(22 + comment.length);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, o.count ?? entries.length, true);
  ev.setUint16(10, o.count ?? entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  ev.setUint16(20, comment.length, true);
  end.set(comment, 22);
  parts.push(end);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

const INDEX: E = { name: "index.html", data: "<!doctype html><title>t</title><p>hi</p>", method: 8 };
async function refused(zip: Uint8Array): Promise<SiteError> {
  const e = await readSite(zip).then(() => null, (x: unknown) => x);
  expect(e, "the zip must be refused").toBeInstanceOf(SiteError);
  if (process.env.REV_DUMP) appendFileSync(process.env.REV_DUMP, `${expect.getState().currentTestName}\n   -> ${(e as SiteError).code}: ${(e as SiteError).message}\n`);
  return e as SiteError;
}
/** What the Instance would serve for an entry: its bytes, inflated, from the zip as stored. */
async function served(zip: Uint8Array, e: SiteEntry): Promise<Uint8Array> {
  const stored = new Blob([zip.subarray(e.offset, e.offset + e.csize)]).stream();
  return new Uint8Array(await new Response(entryStream(stored, e)).arrayBuffer());
}

// ---------- zips a common tool makes ----------
describe("a zip made by a common tool is accepted and serves exactly its files", () => {
  const tree = join(work, "tree", "site");
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, data: Uint8Array | string) => {
    const full = join(tree, path);
    mkdirSync(join(full, ".."), { recursive: true });
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    writeFileSync(full, bytes);
    files[path] = bytes;
  };
  const noise = new Uint8Array(4000).map((_, i) => (i * 2654435761) >>> 24);
  put("index.html", "<!doctype html><title>t</title><link rel=stylesheet href=css/site.css><script src=js/app.js></script>".repeat(20));
  put("css/site.css", "body{margin:0}\n".repeat(300));
  put("js/app.js", "console.log('x');\n".repeat(200));
  put("img/pixel.png", noise);
  put("data/ação é ü.json", '{"ok":true}');
  put("empty.txt", "");
  put("sub dir/with space.html", "<p>space</p>");
  put("a/b/c/d/deep.txt", "deep");

  async function check(zipPath: string): Promise<void> {
    const zip = new Uint8Array(readFileSync(zipPath));
    const entries = await readSite(zip);
    expect(entries.map((e) => e.path).sort()).toEqual(Object.keys(files).sort());
    for (const e of entries) {
      const got = await served(zip, e);
      expect(Buffer.from(got).equals(Buffer.from(files[e.path]!)), e.path).toBe(true);
    }
  }
  const sh = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, stdio: "pipe" });

  test("Info-ZIP zip -r, from inside the folder", async () => {
    const out = join(work, "infozip-inside.zip");
    sh("zip", ["-r", "-q", "-X", out, "."], tree);
    await check(out);
  });
  test("Info-ZIP zip -r, the folder itself (one shared top folder)", async () => {
    const out = join(work, "infozip-parent.zip");
    sh("zip", ["-r", "-q", out, "site"], join(tree, ".."));
    await check(out);
  });
  test("Info-ZIP streamed to a pipe (data descriptors)", async () => {
    const out = join(work, "infozip-stream.zip");
    const bytes = execFileSync("zip", ["-r", "-q", "-", "."], { cwd: tree, maxBuffer: 1 << 24 });
    writeFileSync(out, bytes);
    await check(out);
  });
  test("macOS ditto, as Finder compresses (top folder + __MACOSX)", async () => {
    const out = join(work, "ditto-keep.zip");
    sh("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", tree, out], work);
    await check(out);
  });
  test("macOS ditto without the parent", async () => {
    const out = join(work, "ditto-flat.zip");
    sh("ditto", ["-c", "-k", "--sequesterRsrc", tree, out], work);
    await check(out);
  });
  test("bsdtar -a -cf site.zip site (the folder)", async () => {
    const out = join(work, "bsdtar-parent.zip");
    sh("bsdtar", ["-a", "-cf", out, "-C", join(tree, ".."), "site"], work);
    await check(out);
  });
  test("bsdtar -a -cf site.zip -C site . (names start with ./)", async () => {
    const out = join(work, "bsdtar-dot.zip");
    sh("bsdtar", ["-a", "-cf", out, "-C", tree, "."], work);
    await check(out);
  });
  test("git archive --format=zip (a zip comment holds the commit id; directory entries)", async () => {
    const repo = join(work, "gitrepo");
    mkdirSync(join(repo, "assets/img"), { recursive: true });
    writeFileSync(join(repo, "index.html"), "<!doctype html><title>g</title>".repeat(30));
    writeFileSync(join(repo, "assets/site.css"), "p{}\n".repeat(100));
    writeFileSync(join(repo, "assets/img/a.bin"), noise);
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=r", "-c", "user.email=r@example.com", ...args], { cwd: repo, stdio: "pipe" });
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "x");
    const out = join(work, "git-archive.zip");
    git("archive", "--format=zip", "-o", out, "HEAD");
    const zip = new Uint8Array(readFileSync(out));
    const entries = await readSite(zip);
    expect(entries.map((e) => e.path).sort()).toEqual(["assets/img/a.bin", "assets/site.css", "index.html"]);
    for (const e of entries) expect(Buffer.from(await served(zip, e)).equals(readFileSync(join(repo, e.path))), e.path).toBe(true);
  });
  test("Python zipfile, deflated and stored", async () => {
    for (const mode of ["ZIP_DEFLATED", "ZIP_STORED"]) {
      const out = join(work, `py-${mode}.zip`);
      const script = join(work, "mk.py");
      writeFileSync(script, `import sys, os, zipfile\nroot, out, mode = sys.argv[1:4]\nwith zipfile.ZipFile(out, 'w', getattr(zipfile, mode)) as z:\n  for d, _, fs in os.walk(root):\n    for f in fs:\n      p = os.path.join(d, f)\n      z.write(p, os.path.relpath(p, root))\n`);
      sh("python3", ["-I", script, tree, out, mode], work);
      await check(out);
    }
  });
});

// ---------- hostile zips ----------
describe("a hostile zip cannot escape, hide or overclaim", () => {
  test("the control: my builder's honest zip is accepted", async () => {
    const zip = build([INDEX, { name: "css/a.css", data: "p{}", method: 8 }]);
    expect((await readSite(zip)).map((e) => e.path)).toEqual(["index.html", "css/a.css"]);
  });

  test.each([
    ["parent segment", "../evil.html"],
    ["nested parent", "a/../../evil.html"],
    ["absolute", "/etc/passwd"],
    ["dot segment", "a/./x.html"],
    ["empty segment", "a//b.html"],
    ["backslash", "a\\b.html"],
    ["windows drive", "C:\\x.html"],
    ["nul byte", "a\u0000b.html"],
    ["newline", "a\nb.html"],
    ["del char", "a\u007fb.html"],
  ])("refuses a name with a %s", async (_label, name) => {
    expect((await refused(build([INDEX, { name, data: "x" }]))).code).toBe("site_invalid");
  });

  test("a leading ./ (a zip made from \".\") reads from the top, and still cannot make a duplicate", async () => {
    expect((await readSite(build([INDEX, { name: "./x.html", data: "x" }]))).map((e) => e.path)).toEqual(["index.html", "x.html"]);
    expect((await refused(build([INDEX, { name: "x.html", data: "1" }, { name: "./x.html", data: "2" }]))).code).toBe("site_invalid");
  });

  test("a path over 512 bytes is refused", async () => {
    expect((await refused(build([INDEX, { name: "a/".repeat(260) + "x.html", data: "x" }]))).code).toBe("site_invalid");
  });

  test("a symbolic link entry is refused, even when named like a file", async () => {
    const e = await refused(build([INDEX, { name: "link.html", data: "/etc/passwd", mode: 0o120777 }]));
    expect(e.message).toMatch(/symbolic link/);
  });
  test("a device or fifo entry is refused", async () => {
    await refused(build([INDEX, { name: "fifo", data: "", mode: 0o010644 }]));
  });

  test("a deflated file that inflates past its limit is refused as too large, before it is stored", async () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    const e = await refused(build([INDEX, { name: "big.bin", data: big, method: 8 }]));
    expect(e.code).toBe("site_too_large");
  });
  test("a file that inflates to MORE than it declares (under-claimed size) is refused", async () => {
    const e = await refused(build([INDEX, { name: "a.bin", data: new Uint8Array(4 * 1024 * 1024), method: 8, size: 10 }]));
    expect(e.code).toBe("site_invalid");
  });
  test("a deflate bomb is cut off at its declared size: the reader never inflates more than a few chunks past it", async () => {
    // 128 MiB of zeros deflates to about 130 KB. The entry declares 10 bytes. The reader must stop soon after 10, not
    // inflate all 128 MiB (a 10 MiB zip could otherwise cost gigabytes of CPU).
    const bomb = deflateRawSync(Buffer.alloc(128 * 1024 * 1024), { level: 9 });
    const g = globalThis as unknown as { DecompressionStream: new (format: string) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } };
    const Real = g.DecompressionStream;
    let inflated = 0;
    class Counting {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
      constructor(format: string) {
        const real = new Real(format);
        this.writable = real.writable;
        this.readable = real.readable.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, out) {
            inflated += chunk.byteLength;
            out.enqueue(chunk);
          },
        }));
      }
    }
    g.DecompressionStream = Counting as unknown as typeof Real;
    try {
      const e = await refused(build([INDEX, { name: "bomb.bin", data: new Uint8Array(10), method: 8, rawBody: bomb, size: 10 }]));
      expect(e.code).toBe("site_invalid");
    } finally {
      g.DecompressionStream = Real;
    }
    // The control file index.html inflates too (a few dozen bytes); everything else must be tiny.
    expect(inflated).toBeLessThan(8 * 1024 * 1024);
  });
  test("a file that inflates to LESS than it declares is refused", async () => {
    await refused(build([INDEX, { name: "a.bin", data: "short", method: 8, size: 4000 }]));
  });
  test("a wrong CRC is refused (deflated and stored)", async () => {
    await refused(build([INDEX, { name: "a.txt", data: "hello", method: 8, crc: 1234 }]));
    await refused(build([INDEX, { name: "b.txt", data: "hello", method: 0, crc: 1234 }]));
  });
  test("stored with two different sizes is refused", async () => {
    await refused(build([INDEX, { name: "a.txt", data: "hello", method: 0, size: 3 }]));
  });
  test("many files that together exceed 25 MiB are refused", async () => {
    const chunk = new Uint8Array(4 * 1024 * 1024);
    const entries = [INDEX, ...Array.from({ length: 7 }, (_, i): E => ({ name: `z${i}.bin`, data: chunk, method: 8 }))];
    expect((await refused(build(entries))).code).toBe("site_too_large");
  });
  test("more than 1000 files are refused", async () => {
    const entries = [INDEX, ...Array.from({ length: 1000 }, (_, i): E => ({ name: `f${i}.txt`, data: "x" }))];
    expect((await refused(build(entries))).code).toBe("site_too_large");
  });
  test("a directory entry with content is refused", async () => {
    await refused(build([INDEX, { name: "d/", data: "payload", mode: 0o040755 }]));
  });

  test("two entries with one name and one local header (shared bytes) are refused as overlapping", async () => {
    const e = await refused(build([INDEX, { name: "a.html", data: "x".repeat(2000), method: 8 }, { name: "a.html", data: "x".repeat(2000), method: 8, pointAt: 1 }]));
    expect(e.message).toMatch(/overlap/);
  });
  test("a file whose local header sits inside another file's bytes (the overlapping-files zip bomb) is refused", async () => {
    const html = "<!doctype html><title>t</title><p>nested</p>";
    const inner = build([{ name: "index.html", data: html }]);
    const innerLocalLength = 30 + "index.html".length + html.length;
    const carrier = { name: "pay.bin", data: inner.subarray(0, innerLocalLength), method: 0 as const };
    const e = await refused(build([carrier, { name: "index.html", data: html, pointAtAbs: 30 + "pay.bin".length }]));
    expect(e.message).toMatch(/overlap/);
  });
  test("a central entry whose local header names another file is refused (hiding index.html behind another name)", async () => {
    await refused(build([{ ...INDEX, localName: "other.html" }]));
  });
  test("duplicate names, including NFC and NFD spellings of one name, are refused", async () => {
    await refused(build([INDEX, { name: "a.txt", data: "1" }, { name: "a.txt", data: "2" }]));
    await refused(build([INDEX, { name: "caf\u00e9.txt", data: "1" }, { name: "cafe\u0301.txt", data: "2" }]));
  });
  test("an unrelated byte string between the directory and the end record is refused", async () => {
    await refused(build([INDEX], { gap: enc.encode("EVIL") }));
  });
  test("bytes after the end record are not accepted as a zip", async () => {
    const zip = build([INDEX]);
    const more = new Uint8Array(zip.length + 4);
    more.set(zip);
    more.set(enc.encode("tail"), zip.length);
    await refused(more);
  });
  test("a fake end record inside the comment cannot redirect the reader to other files", async () => {
    const inner = build([{ name: "index.html", data: "EVIL INDEX" }]);
    const zip = build([INDEX], { comment: inner });
    // Whatever the reader decides, it must either refuse or serve the REAL index.html, never the one in the comment.
    const entries = await readSite(zip).catch(() => null);
    if (entries) expect(Buffer.from(await served(zip, entries[0]!)).toString()).toBe("<!doctype html><title>t</title><p>hi</p>");
  });
  test("a directory count that disagrees with the directory is refused", async () => {
    await refused(build([INDEX], { count: 2 }));
  });
  test("encrypted entries, unknown methods and ZIP64 markers are refused", async () => {
    await refused(build([INDEX, { name: "enc.txt", data: "x", flags: 0x0801 }]));
    await refused(build([INDEX, { name: "bz.txt", data: "x", method: 12 as unknown as 0 }]));
    await refused(build([INDEX, { name: "huge.bin", data: "x", size: 0xffffffff }]));
  });
  test("entries past the end of the directory (csize runs into it) are refused", async () => {
    await refused(build([INDEX, { name: "a.txt", data: "hello", csize: 100000 }]));
  });
  test("a non-UTF-8 name is refused", async () => {
    const zip = build([INDEX, { name: "caf\u00e9.txt", data: "x" }]);
    // Turn the UTF-8 bytes C3 A9 into the lone byte E9 in both headers by replacing in place and shrinking is
    // awkward; invalid sequence C3 28 keeps the length.
    const out = zip.slice();
    for (let i = 0; i < out.length - 1; i++) if (out[i] === 0xc3 && out[i + 1] === 0xa9) out[i + 1] = 0x28;
    await refused(out);
  });
  test("no index.html at the top is refused; two top folders are not unwrapped", async () => {
    await refused(build([{ name: "page.html", data: "x" }]));
    await refused(build([{ name: "a/index.html", data: "x" }, { name: "b/other.html", data: "y" }]));
  });
  test("files that are not a zip, and an empty zip, are refused", async () => {
    await refused(enc.encode("<!doctype html><p>not a zip</p>"));
    await refused(new Uint8Array());
    await refused(build([]));
  });
  test("trailing junk after a deflate stream inside its entry is refused (the stored bytes must be exactly the stream)", async () => {
    const data = enc.encode("<p>x</p>".repeat(50));
    const deflated = deflateRawSync(data);
    const body = new Uint8Array(deflated.length + 8);
    body.set(deflated);
    body.set(enc.encode("JUNKJUNK"), deflated.length);
    await refused(build([{ name: "index.html", data, method: 8, rawBody: body }]));
  });
  test("a truncated deflate stream is refused", async () => {
    const data = enc.encode("<p>x</p>".repeat(500));
    const deflated = deflateRawSync(data);
    await refused(build([{ name: "index.html", data, method: 8, rawBody: deflated.subarray(0, deflated.length - 3) }]));
  });

  test("what looks like a hidden entry is not served: __MACOSX and .DS_Store are dropped, nothing else is invented", async () => {
    const zip = build([INDEX, { name: "__MACOSX/._index.html", data: "junk" }, { name: ".DS_Store", data: "x" }, { name: "img/.DS_Store", data: "x" }]);
    expect((await readSite(zip)).map((e) => e.path)).toEqual(["index.html"]);
  });
  test("one shared top folder is removed, and only then", async () => {
    const zip = build([{ name: "site/", mode: 0o040755 }, { name: "site/index.html", data: "x" }, { name: "site/css/a.css", data: "y" }]);
    expect((await readSite(zip)).map((e) => e.path)).toEqual(["index.html", "css/a.css"]);
  });
});

// ---------- the request path pipeline ----------
describe("a request path is decoded and checked by the zip's own rules", () => {
  test.each([
    ["", "index.html"],
    ["index.html", "index.html"],
    ["css/a.css", "css/a.css"],
    ["sub/", "sub/index.html"],
    ["sub%20dir/with%20space.html", "sub dir/with space.html"],
    ["caf%C3%A9.txt", "caf\u00e9.txt"],
    ["cafe%CC%81.txt", "caf\u00e9.txt"], // NFD in the URL meets NFC in the index
  ])("%j asks for %j", (rest, path) => {
    expect(siteRequestPath(rest)).toBe(path);
  });
  test.each(["..", "../x", "a/../x", "%2e%2e/x", "%2E%2E/x", ".", "./x", "a%2Fb", "a%2fb", "a%5Cb", "a%5cb", "%00", "a%0Ab", "%", "%E0%A4%A", "a//b", "//x"])(
    "%j is refused",
    (rest) => {
      expect(siteRequestPath(rest)).toBeNull();
    },
  );
});

// ---------- tickets ----------
describe("tickets", () => {
  const KEY = "A".repeat(43);
  const other = "B".repeat(42) + "A";
  const aud = "aud-one";
  const t = { slug: "abcDEF123456", n: 3, email: "viewer@example.com", exp: Date.now() + 3600_000 };
  const keyOf = async (raw: string) => (await importTicketKey(raw))!;

  test("seals and opens", async () => {
    const k = await keyOf(KEY);
    expect(await openTicket(k, aud, await sealTicket(k, aud, t))).toEqual(t);
  });
  test("the email, slug and Version are not readable in the URL, in any common encoding", async () => {
    const k = await keyOf(KEY);
    const s = await sealTicket(k, aud, t);
    const decoded = Buffer.from(s, "base64url").toString("latin1");
    for (const needle of ["viewer", "example.com", t.slug]) {
      expect(s).not.toContain(needle);
      expect(decoded).not.toContain(needle);
    }
    expect(Buffer.from(t.email).toString("base64url").slice(0, 12)).not.toBe("");
    expect(s).not.toContain(Buffer.from(t.email).toString("base64url").slice(0, 12));
  });
  test("two tickets for one payload differ (fresh nonce)", async () => {
    const k = await keyOf(KEY);
    expect(await sealTicket(k, aud, t)).not.toBe(await sealTicket(k, aud, t));
  });
  test("changing any single character, at any position, makes it unreadable", async () => {
    const k = await keyOf(KEY);
    const s = await sealTicket(k, aud, t);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let opened = 0;
    for (let i = 0; i < s.length; i++) {
      for (const c of [alphabet[(alphabet.indexOf(s[i]!) + 1) % 64]!, alphabet[(alphabet.indexOf(s[i]!) + 32) % 64]!]) {
        if ((await openTicket(k, aud, s.slice(0, i) + c + s.slice(i + 1))) !== null) opened++;
      }
    }
    expect(opened).toBe(0);
  });
  test("truncated, extended, padded and foreign strings are unreadable", async () => {
    const k = await keyOf(KEY);
    const s = await sealTicket(k, aud, t);
    for (const bad of [s.slice(0, -1), s.slice(0, -4), s + "A", s + "AAAA", s + "=", "", "A".repeat(40), "A".repeat(2000), s.replace(/[A-Za-z]/, "+"), s + "/"]) {
      expect(await openTicket(k, aud, bad), bad.slice(0, 20)).toBeNull();
    }
  });
  test("a ticket of another Instance (key) or another Access audience is unreadable", async () => {
    const k = await keyOf(KEY);
    const s = await sealTicket(k, aud, t);
    expect(await openTicket(await keyOf(other), aud, s)).toBeNull();
    expect(await openTicket(k, "aud-two", s)).toBeNull();
  });
  test("an expired ticket still opens (the caller compares exp), and carries its exp", async () => {
    const k = await keyOf(KEY);
    const past = { ...t, exp: Date.now() - 1000 };
    expect((await openTicket(k, aud, await sealTicket(k, aud, past)))?.exp).toBe(past.exp);
  });
  test("the ticket key must be exactly 32 bytes of canonical unpadded base64url", async () => {
    for (const bad of ["", "A".repeat(42), "A".repeat(44), "A".repeat(43) + "=", "A".repeat(42) + "+", "A".repeat(42) + "B"]) {
      expect(await importTicketKey(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(await importTicketKey(KEY)).not.toBeNull();
  });
});

// ---------- settings fail closed ----------
describe("Instance settings", () => {
  const base = {
    DB: {} as D1Database, BODIES: {} as R2Bucket, ACCESS_TEAM_URL: "https://team.cloudflareaccess.com", ACCESS_AUD: "aud",
    AUTHOR_EMAIL: "a@example.com", TICKET_KEY: "A".repeat(43),
  };
  test("expiryDays defaults to 30; 0 and 3650 are accepted; anything else is a missing configuration", () => {
    expect(readConfig(base)?.expiryDays).toBe(30);
    expect(readConfig({ ...base, EXPIRY_DAYS: "0" })?.expiryDays).toBe(0);
    expect(readConfig({ ...base, EXPIRY_DAYS: "3650" })?.expiryDays).toBe(3650);
    for (const bad of ["3651", "-1", "1.5", "abc", "1e3", "0x10", " ", "30 days"]) expect(readConfig({ ...base, EXPIRY_DAYS: bad }), bad).toBeNull();
  });
  test("a missing or malformed ticket key makes the whole configuration missing", () => {
    expect(readConfig({ ...base, TICKET_KEY: undefined })).toBeNull();
    for (const bad of ["", "short", "A".repeat(44), "A".repeat(42) + "!", "A".repeat(42) + "="]) expect(readConfig({ ...base, TICKET_KEY: bad }), bad).toBeNull();
  });
  // Requirement (plan 009, Setup): "A missing or malformed key makes readConfig return null (fail closed)".
  // A 43-character string whose last character carries nonzero padding bits is not a canonical 32-byte key.
  test("a non-canonical 43-character ticket key is also refused by readConfig, not accepted and then unusable", async () => {
    const noncanonical = "A".repeat(42) + "B";
    expect(await importTicketKey(noncanonical)).toBeNull();
    expect(readConfig({ ...base, TICKET_KEY: noncanonical })).toBeNull();
  });
});

// ---------- the CLI's --expires ----------
describe("the CLI reads --expires", () => {
  const now = Date.UTC(2026, 9, 9, 12);
  test("the documented forms", () => {
    expect(parseExpires("never", now)).toBeNull();
    expect(parseExpires("30d", now)).toBe(now + 30 * 86_400_000);
    expect(parseExpires("12h", now)).toBe(now + 12 * 3_600_000);
    expect(parseExpires("2026-12-31", now)).toBe(Date.UTC(2026, 11, 31));
    expect(parseExpires("2026-12-31T18:00:00Z", now)).toBe(Date.UTC(2026, 11, 31, 18));
    expect(parseExpires("2026-12-31T18:00:00-03:00", now)).toBe(Date.UTC(2026, 11, 31, 21));
  });
  test.each(["", "soon", "0d", "-1d", "30", "1w", "2026-13-01", "2026-12-32", "2026-12-31T18:00:00", "12:00"])("%j is refused", (bad) => {
    expect(() => parseExpires(bad, now), bad).toThrow();
  });
  // A calendar date that does not exist must not be silently moved to another day (V8's Date.parse rolls 02-31 to 03-03).
  test.each(["2026-02-31", "2026-02-30", "2026-04-31", "2026-11-31"])("an impossible calendar date %s is refused, not moved to another day", (bad) => {
    expect(() => parseExpires(bad, now), bad).toThrow();
  });
});
