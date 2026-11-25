import { constants } from "node:fs";
import { lstat, open, readdir, readlink, type FileHandle } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";
import { CliError } from "./errors.js";
import { SITE_LIMITS, writeZip, type ZipFile } from "./zip.js";

export type Content = { kind: "page"; html: string } | { kind: "site"; zip: Uint8Array };

export const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_KEYS = 10;

// macOS sys/fcntl.h (11+): fail open if any path component is a symlink; not exported by Node.
const O_NOFOLLOW_ANY = 0x20000000;

async function openReal(path: string): Promise<FileHandle> {
  const linked = () => new CliError("unsafe_path", `${path} goes through a symbolic link. The CLI publishes only a real file, named by its real path.`, {
    hint: "Pass the file's real path (see `realpath`), or check who else can write to its directory.",
  });
  // O_NONBLOCK prevents opening a FIFO from blocking before fstat.
  const flags = constants.O_RDONLY | constants.O_NONBLOCK;
  if (process.platform === "darwin") {
    // macOS /tmp, /var, and /etc are symlinks into /private.
    const real = path.replace(/^\/(tmp|var|etc)(?=\/|$)/, "/private/$1");
    return open(real, flags | O_NOFOLLOW_ANY).catch((e: NodeJS.ErrnoException) => {
      throw e.code === "ELOOP" ? linked() : e;
    });
  }
  if (process.platform !== "linux") {
    // Other platforms lack O_NOFOLLOW_ANY and /proc/self/fd; component lstat before open is best-effort against concurrent writes.
    const { root } = parse(path);
    let at = root;
    for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
      at = join(at, part);
      if ((await lstat(at)).isSymbolicLink()) throw linked();
    }
  }
  const fh = await open(path, flags | constants.O_NOFOLLOW).catch((e: NodeJS.ErrnoException) => {
    throw e.code === "ELOOP" ? linked() : e;
  });
  // Linux has no O_NOFOLLOW_ANY: confirm the opened descriptor's resolved path matches what was requested.
  if (process.platform === "linux") {
    let resolved: string;
    try {
      resolved = await readlink(`/proc/self/fd/${fh.fd}`);
    } catch (e) {
      await fh.close();
      throw e;
    }
    if (resolved !== path) {
      await fh.close();
      throw linked();
    }
  }
  return fh;
}

export async function loadPublishable(file: string): Promise<{ filePath: string; content: Content }> {
  const filePath = resolve(file);
  const isZip = /\.zip$/i.test(filePath);
  const cap = isZip ? SITE_LIMITS.zipBytes : MAX_HTML_BYTES;
  const read = await readReal(filePath, file, cap, isZip ? "a site's zip" : "a Share", true);
  if (read === "folder") return { filePath, content: { kind: "site", zip: await zipFolder(filePath, file) } };
  if (isZip) return { filePath, content: { kind: "site", zip: new Uint8Array(read) } };
  return { filePath, content: { kind: "page", html: new TextDecoder().decode(read) } };
}

async function readReal(filePath: string, shown: string, cap: number, what: string, folders: boolean): Promise<Uint8Array | "folder"> {
  const notFound = () => new CliError("file_not_found", `No such file: ${shown}`, { hint: "Pass an HTML file, a .zip or a folder with an index.html." });
  const fh = await openReal(filePath).catch((e: unknown) => {
    if (e instanceof CliError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw notFound();
    throw new CliError("file_unreadable", `Cannot read ${shown}: ${code === "EACCES" || code === "EPERM" ? "permission denied" : (code ?? "unknown error")}.`, {
      hint: "Check the file's permissions.",
    });
  });
  try {
    const st = await fh.stat();
    if (folders && st.isDirectory()) return "folder";
    if (!st.isFile()) throw notFound();
    const tooLarge = (size: number | string) => new CliError("file_too_large", `${shown} is ${size} bytes; ${what} is at most ${cap}.`, {
      hint: "Inline less, or compress images.",
    });
    if (st.size > cap) throw tooLarge(st.size);
    const chunks: Buffer[] = [];
    let n = 0;
    const chunkSize = Math.min(Math.max(st.size + 1, 4096), 64 * 1024);
    for (;;) {
      const want = Math.min(chunkSize, cap + 1 - n);
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, n);
      if (bytesRead === 0) break;
      n += bytesRead;
      if (n > cap) throw tooLarge("more than " + cap);
      chunks.push(buf.subarray(0, bytesRead));
    }
    return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, n);
  } finally {
    await fh.close();
  }
}

async function zipFolder(root: string, shown: string): Promise<Uint8Array> {
  const files: ZipFile[] = [];
  let total = 0;
  const tooLarge = (message: string) => new CliError("file_too_large", message, { hint: "Leave out large media, or publish fewer files." });
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (prefix === "" && e.name === "__MACOSX") continue;
      const path = prefix + e.name;
      if (e.isSymbolicLink()) {
        throw new CliError("unsafe_path", `${join(shown, path)} is a symbolic link. A site is published from real files only.`, {
          hint: "Copy the file into the folder, or remove the link.",
        });
      }
      if (e.isDirectory()) {
        await walk(join(dir, e.name), path + "/");
        continue;
      }
      if (!e.isFile()) throw new CliError("unsafe_path", `${join(shown, path)} is not a regular file.`);
      if (Buffer.byteLength(path) > SITE_LIMITS.pathBytes) {
        throw new CliError("site_invalid", `${join(shown, path)} is too long: a path is at most ${SITE_LIMITS.pathBytes} bytes.`);
      }
      if (files.length === SITE_LIMITS.files) throw tooLarge(`${shown} has more than ${SITE_LIMITS.files} files; a site has at most ${SITE_LIMITS.files}.`);
      const data = await readReal(join(dir, e.name), join(shown, path), SITE_LIMITS.fileBytes, "a site's file", false);
      if (data === "folder") throw new CliError("unsafe_path", `${join(shown, path)} changed into a folder while it was read.`);
      total += data.length;
      if (total > SITE_LIMITS.totalBytes) throw tooLarge(`${shown} holds more than ${SITE_LIMITS.totalBytes} bytes; a site holds at most that.`);
      files.push({ path, data: new Uint8Array(data) });
    }
  }
  await walk(root, "");
  if (!files.some((f) => f.path === "index.html")) {
    throw new CliError("site_invalid", `${shown} has no index.html at its top.`, { hint: "A site opens at its index.html." });
  }
  const zip = writeZip(files);
  if (zip.length > SITE_LIMITS.zipBytes) throw tooLarge(`${shown} zips to ${zip.length} bytes; a site's zip is at most ${SITE_LIMITS.zipBytes}.`);
  return zip;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseExpires(raw: string, now: number): number | null {
  const s = raw.trim();
  if (s === "never") return null;
  const rel = /^([1-9][0-9]{0,4})([dh])$/.exec(s);
  if (rel) return now + Number(rel[1]) * (rel[2] === "d" ? DAY_MS : DAY_MS / 24);
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s) || /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9]{2}:[0-9]{2})$/.test(s)) {
    // JS Date.parse rolls invalid calendar dates over (e.g. 2026-02-31 -> Mar 3).
    const [y, m, d] = s.slice(0, 10).split("-").map(Number) as [number, number, number];
    const day = new Date(Date.UTC(y, m - 1, d));
    const real = day.getUTCFullYear() === y && day.getUTCMonth() === m - 1 && day.getUTCDate() === d;
    const at = Date.parse(s.length === 10 ? s + "T00:00:00Z" : s);
    if (real && Number.isFinite(at)) return at;
  }
  throw new CliError("invalid_arg", `--expires "${raw}" is not a time.`, {
    hint: "Use never, 30d, 12h, 2026-12-31 (00:00 UTC) or 2026-12-31T18:00:00Z.",
  });
}

export function parseMetadata(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 0) throw new CliError("invalid_arg", `The tag --metadata "${pair}" must be in key=value form.`);
    if (eq === 0) throw new CliError("invalid_arg", `The tag --metadata "${pair}" has an empty key.`);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  if (Object.keys(out).length > MAX_KEYS) throw new CliError("invalid_arg", `A Share has at most ${MAX_KEYS} tags.`);
  return out;
}
