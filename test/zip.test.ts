// The site zip reader (src/zip.ts) on its own: what it accepts, what it refuses, and that a stored entry
// serves back exactly what was zipped. Runs in Node; no Worker needed. test/fixtures/site-*.zip were made by
// other tools (Info-ZIP zip, macOS ditto, Python's zipfile) from one folder, so the reader is not only
// tested against our own writer.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { writeZip } from "../packages/cli/src/zip";
import { entryStream, readSite, SITE_LIMITS, SiteError, siteRequestPath, type SiteEntry } from "../src/zip";

interface Raw {
  name: string | Uint8Array;
  data?: Uint8Array | string;
  method?: number;
  flags?: number;
  madeBy?: number;
  extAttr?: number;
  /** Overrides written into the central directory only. */
  size?: number;
  csize?: number;
  localName?: string;
  /** Point this entry's central record at an earlier entry's local header. */
  sameLocalAs?: number;
  /** The CRC written in the central directory. */
  crc?: number;
  /** Change the stored bytes after compressing: append junk, or cut the end off. */
  junk?: string;
  cut?: number;
}

const enc = new TextEncoder();
const bytes = (d: Uint8Array | string | undefined) => (typeof d === "string" ? enc.encode(d) : (d ?? new Uint8Array()));

/** A zip built byte by byte, so a test can write what no well-behaved tool would. */
function rawZip(entries: Raw[], opts: { afterDirectory?: string } = {}): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  const offsets: number[] = [];
  let at = 0;
  for (const e of entries) {
    const name = typeof e.name === "string" ? enc.encode(e.name) : e.name;
    const plain = bytes(e.data);
    const method = e.method ?? 8;
    let stored = method === 8 ? new Uint8Array(deflateRawSync(plain)) : plain;
    if (e.junk !== undefined) stored = new Uint8Array([...stored, ...enc.encode(e.junk)]);
    if (e.cut !== undefined) stored = stored.slice(0, stored.length - e.cut);
    const local = new Uint8Array(30 + (e.localName !== undefined ? enc.encode(e.localName).length : name.length) + stored.length);
    const lname = e.localName !== undefined ? enc.encode(e.localName) : name;
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, e.flags ?? 0x0800, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc32(plain), true);
    lv.setUint32(18, stored.length, true);
    lv.setUint32(22, plain.length, true);
    lv.setUint16(26, lname.length, true);
    local.set(lname, 30);
    local.set(stored, 30 + lname.length);
    const offset = e.sameLocalAs !== undefined ? offsets[e.sameLocalAs]! : at;
    offsets.push(offset);
    if (e.sameLocalAs === undefined) {
      locals.push(local);
      at += local.length;
    }
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, e.madeBy ?? (3 << 8) | 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, e.flags ?? 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, e.crc ?? crc32(plain), true);
    cv.setUint32(20, e.csize ?? stored.length, true);
    cv.setUint32(24, e.size ?? plain.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, e.extAttr ?? (0o100644 << 16) >>> 0, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const between = enc.encode(opts.afterDirectory ?? "");
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, at, true);
  const out = new Uint8Array(at + cdSize + between.length + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, between, eocd]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

const INDEX = { name: "index.html", data: "<!doctype html><title>t</title><link rel=stylesheet href=style.css>" };

async function refused(zip: Uint8Array, code: string, mention?: string) {
  const err = await readSite(zip).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(SiteError);
  expect((err as SiteError).code).toBe(code);
  if (mention !== undefined) expect((err as SiteError).message).toContain(mention);
}

async function served(zip: Uint8Array, e: SiteEntry): Promise<string> {
  const raw = new Blob([zip.slice(e.offset, e.offset + e.csize)]).stream();
  return new Response(entryStream(raw, e)).text();
}

describe("a site zip that is accepted", () => {
  test.each(["site-infozip.zip", "site-ditto.zip", "site-python.zip"])("%s, made by another tool", async (name) => {
    const zip = new Uint8Array(readFileSync(join(process.cwd(), "test/fixtures", name)));
    const site = await readSite(zip);
    expect(site.map((e) => e.path).sort()).toEqual(["caf\u00e9.txt", "css/style.css", "data.json", "empty.txt", "img/dot.svg", "index.html"]);
    expect(await served(zip, site.find((e) => e.path === "css/style.css")!)).toBe("p { color: rgb(1, 2, 3); }\n");
    expect(await served(zip, site.find((e) => e.path === "empty.txt")!)).toBe("");
  });

  test("the CLI's own zip reads back file by file, deflated or stored", async () => {
    const files = [
      { path: "index.html", data: enc.encode("<!doctype html><title>t</title>" + "x".repeat(4000)) },
      { path: "img/dot.png", data: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) },
      { path: "data.json", data: enc.encode('{"a":1}') },
    ];
    const zip = writeZip(files);
    const site = await readSite(zip);
    expect(site.map((e) => e.path).sort()).toEqual(["data.json", "img/dot.png", "index.html"]);
    for (const f of files) {
      const e = site.find((x) => x.path === f.path)!;
      expect(e.size).toBe(f.data.length);
      expect(new Uint8Array(await new Response(entryStream(new Blob([zip.slice(e.offset, e.offset + e.csize)]).stream(), e)).arrayBuffer())).toEqual(f.data);
    }
    expect(site.find((e) => e.path === "index.html")!.method).toBe(8);
  });

  test("one shared top folder is stripped; directories and macOS extras are skipped", async () => {
    const site = await readSite(rawZip([
      { name: "site/" },
      { name: "site/index.html", data: INDEX.data },
      { name: "site/css/style.css", data: "p{}" },
      { name: "__MACOSX/site/._index.html", data: "junk" },
      { name: "site/.DS_Store", data: "junk" },
    ]));
    expect(site.map((e) => e.path).sort()).toEqual(["css/style.css", "index.html"]);
  });

  test("a file never serves more than its proven size, whatever its stored bytes say", async () => {
    const zip = writeZip([{ path: "index.html", data: enc.encode("x".repeat(5000)) }]);
    const [e] = await readSite(zip);
    const lying = { ...e!, size: 100 };
    await expect(served(zip, lying)).rejects.toThrow();
  });

  test("names are UTF-8 even without the flag, and stored in NFC", async () => {
    const site = await readSite(rawZip([INDEX, { name: "cafe\u0301.txt", data: "x", flags: 0 }]));
    expect(site.map((e) => e.path)).toContain("caf\u00e9.txt");
    const stored = rawZip([INDEX, { name: "a.txt", data: "ol\u00e1", method: 0 }]);
    expect(await served(stored, (await readSite(stored)).find((e) => e.path === "a.txt")!)).toBe("ol\u00e1");
  });
});

describe("the path a request asks for", () => {
  test.each([
    ["css/style.css", "css/style.css"],
    ["", "index.html"],
    ["docs/", "docs/index.html"],
    ["caf%C3%A9.txt", "caf\u00e9.txt"],
    ["cafe%CC%81.txt", "caf\u00e9.txt"],
    ["x%3F.txt", "x?.txt"],
    ["a%20b.html", "a b.html"],
  ])("%j is %j", (rest, path) => {
    expect(siteRequestPath(rest)).toBe(path);
  });

  test.each(["..", "a/../b", "%2e%2e/x", "./a", "a%2Fb", "a%5Cb", "a//b", "%ZZ", "a%00b", "%2F"])("%j is refused", (rest) => {
    expect(siteRequestPath(rest)).toBeNull();
  });
});

describe("a site zip that is refused", () => {
  test.each([
    ["../evil.html", "outside"],
    ["/etc/passwd", "outside"],
    ["a//b.html", "outside"],
    ["a/./b.html", "outside"],
    ["a\\b.html", "backslash"],
    ["a\u0007.html", "control"],
  ])("a path like %j", async (name, word) => {
    await refused(rawZip([INDEX, { name, data: "x" }]), "site_invalid", word);
  });

  test("a name that is not UTF-8", async () => {
    await refused(rawZip([INDEX, { name: new Uint8Array([0x61, 0xff, 0x2e, 0x74]), data: "x" }]), "site_invalid", "UTF-8");
  });

  test("a symbolic link, or any file that is not a regular file", async () => {
    await refused(rawZip([INDEX, { name: "a.txt", data: "/etc/passwd", method: 0, extAttr: (0o120777 << 16) >>> 0 }]), "site_invalid", "is a symbolic link");
    await refused(rawZip([INDEX, { name: "b.txt", data: "", method: 0, extAttr: (0o010644 << 16) >>> 0 }]), "site_invalid", "is not a regular file");
  });

  test("encryption, an unknown method, and ZIP64 sizes", async () => {
    await refused(rawZip([INDEX, { name: "a.txt", data: "x", flags: 0x0801 }]), "site_invalid", "encrypted");
    await refused(rawZip([INDEX, { name: "a.txt", data: "x", method: 12 }]), "site_invalid", "method");
    await refused(rawZip([INDEX, { name: "a.txt", data: "x", csize: 0xffffffff }]), "site_invalid", "ZIP64");
  });

  test("two files with one name, also once both are in NFC", async () => {
    await refused(rawZip([INDEX, { name: "a.txt", data: "1" }, { name: "a.txt", data: "2" }]), "site_invalid", "twice");
    await refused(rawZip([INDEX, { name: "caf\u00e9", data: "1" }, { name: "cafe\u0301", data: "2" }]), "site_invalid", "twice");
  });

  test("entries that share bytes, a local name that disagrees, and sizes that lie", async () => {
    await refused(rawZip([INDEX, { name: "a.txt", data: "aaaa" }, { name: "a.txt", data: "aaaa", sameLocalAs: 1 }]), "site_invalid", "overlap");
    await refused(rawZip([INDEX, { name: "a.txt", data: "x", localName: "b.txt" }]), "site_invalid", "local");
    await refused(rawZip([INDEX, { name: "a.txt", data: "abcdef", method: 0, size: 3 }]), "site_invalid", "a.txt");
    await refused(rawZip([INDEX, { name: "a.txt", data: "a".repeat(5000), size: 100 }]), "site_invalid", "a.txt");
    await refused(rawZip([INDEX, { name: "a.txt", data: "abc", size: 100 }]), "site_invalid", "a.txt");
  });

  test("bytes that do not inflate cleanly, or that fail their checksum", async () => {
    await refused(rawZip([INDEX, { name: "a.txt", data: "hello ".repeat(50), junk: "JUNK" }]), "site_invalid", "damaged");
    await refused(rawZip([INDEX, { name: "a.txt", data: "hello ".repeat(50), cut: 3 }]), "site_invalid", "a.txt");
    await refused(rawZip([INDEX, { name: "a.txt", data: "hello", crc: 1234 }]), "site_invalid", "checksum");
    await refused(rawZip([INDEX, { name: "a.txt", data: "hello", method: 0, crc: 1234 }]), "site_invalid", "checksum");
  });

  test("no index.html, and bytes that are not a zip", async () => {
    await refused(rawZip([{ name: "page.html", data: "x" }]), "site_invalid", "index.html");
    await refused(enc.encode("<!doctype html> not a zip"), "site_invalid");
    await refused(rawZip([INDEX]).slice(0, 40), "site_invalid");
    await refused(rawZip([INDEX], { afterDirectory: "hidden" }), "site_invalid", "between its directory");
  });

  test("past the limits", async () => {
    expect(SITE_LIMITS).toEqual({ zipBytes: 10 * 1024 * 1024, files: 1000, fileBytes: 5 * 1024 * 1024, totalBytes: 25 * 1024 * 1024, pathBytes: 512 });
    const many = [INDEX, ...Array.from({ length: SITE_LIMITS.files }, (_, i) => ({ name: `f${i}.txt`, data: "x", method: 0 }))];
    await refused(rawZip(many), "site_too_large", "files");
    const folders = [INDEX, ...Array.from({ length: 2 * SITE_LIMITS.files }, (_, i) => ({ name: `d${i}/`, method: 0 }))];
    await refused(rawZip(folders), "site_too_large", "entries");
    await refused(rawZip([INDEX, { name: "big.bin", data: new Uint8Array(SITE_LIMITS.fileBytes + 1) }]), "site_too_large", "big.bin");
    const sixty = Array.from({ length: 6 }, (_, i) => ({ name: `part${i}.bin`, data: new Uint8Array(SITE_LIMITS.fileBytes - 1) }));
    await refused(rawZip([INDEX, ...sixty]), "site_too_large", "unzipped");
    await refused(rawZip([INDEX, { name: "x".repeat(513), data: "x" }]), "site_invalid", "long");
  });
});
