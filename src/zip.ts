// Reading a site's zip (plan 009). The zip is stored unchanged in R2; D1 keeps where each file's bytes
// start, so a file is served with one ranged read. Everything here treats the zip as hostile input:
// it is checked whole before anything is stored, and every deflated file is inflated once to prove
// it is exactly the size it declares, so a stored site always serves what it says.

export const SITE_LIMITS = {
  zipBytes: 10 * 1024 * 1024,
  files: 1000,
  fileBytes: 5 * 1024 * 1024,
  totalBytes: 25 * 1024 * 1024,
  pathBytes: 512,
} as const;

/** One file of a site. `offset` is where its stored bytes start in the zip; `method` 0 is stored, 8 deflated. */
export interface SiteEntry {
  path: string;
  offset: number;
  csize: number;
  size: number;
  method: 0 | 8;
}

/** A site's file index as stored in `versions.files`: path to [offset, compressed size, size, method]. */
export function encodeIndex(entries: SiteEntry[]): string {
  return JSON.stringify(Object.fromEntries(entries.map((e) => [e.path, [e.offset, e.csize, e.size, e.method]])));
}

/** One stored index entry (as `json_each` returns it) back as a SiteEntry. */
export function decodeEntry(path: string, stored: string): SiteEntry {
  const [offset, csize, size, method] = JSON.parse(stored) as [number, number, number, 0 | 8];
  return { path, offset, csize, size, method };
}

/** Every file of a stored index, by path and size. */
export function listIndex(stored: string): { path: string; size: number }[] {
  return Object.entries(JSON.parse(stored) as Record<string, [number, number, number, number]>).map(([path, e]) => ({ path, size: e[2] }));
}

export class SiteError extends Error {
  constructor(public code: "site_invalid" | "site_too_large", message: string) {
    super(message);
  }
}

const invalid = (message: string) => new SiteError("site_invalid", message);
const tooLarge = (message: string) => new SiteError("site_too_large", message);

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50;
const FULL16 = 0xffff;
const FULL32 = 0xffffffff;
const UNIX = 3;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const enc = new TextEncoder();

/** A name as an error shows it: quoted, with anything unprintable escaped, and cut short. */
const quoted = (name: string) => JSON.stringify(name.length > 80 ? name.slice(0, 80) + "…" : name);

/** The zip's files, checked, with one shared top folder removed. Throws a SiteError for anything refused. */
export async function readSite(zip: Uint8Array): Promise<SiteEntry[]> {
  if (zip.length > SITE_LIMITS.zipBytes) throw tooLarge(`A site's zip is at most ${SITE_LIMITS.zipBytes} bytes; this one is ${zip.length}.`);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const within = (at: number, length: number) => at >= 0 && length >= 0 && at + length <= zip.length;

  // The end record is the last thing in the file, followed only by its own comment.
  let eocd = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - FULL16); at--) {
    if (u32(at) === EOCD && at + 22 + u16(at + 20) === zip.length) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw invalid("This is not a zip file.");
  if (eocd >= 20 && u32(eocd - 20) === ZIP64_LOCATOR) throw invalid("ZIP64 archives are not accepted.");
  if (u16(eocd + 4) !== 0 || u16(eocd + 6) !== 0) throw invalid("Zips split across several files are not accepted.");
  const count = u16(eocd + 10);
  const cdSize = u32(eocd + 12);
  const cdStart = u32(eocd + 16);
  if (count === FULL16 || cdSize === FULL32 || cdStart === FULL32) throw invalid("ZIP64 archives are not accepted.");
  if (u16(eocd + 8) !== count || !within(cdStart, cdSize) || cdStart + cdSize > eocd) throw invalid("The zip's directory is damaged.");
  if (cdStart + cdSize < eocd) throw invalid("The zip has data between its directory and its end record.");
  // Skipped entries (folders, macOS extras) still cost work to read: bound them too.
  if (count > 2 * SITE_LIMITS.files) throw tooLarge(`A site's zip has at most ${2 * SITE_LIMITS.files} entries; this one has ${count}.`);

  type Found = SiteEntry & { start: number; end: number; skip: boolean; crc: number };
  const found: Found[] = [];
  let at = cdStart;
  for (let i = 0; i < count; i++) {
    if (!within(at, 46) || u32(at) !== CENTRAL) throw invalid("The zip's directory is damaged.");
    const madeBy = u16(at + 4) >> 8;
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const crc = u32(at + 16);
    const csize = u32(at + 20);
    const size = u32(at + 24);
    const nameLength = u16(at + 28);
    const recordLength = 46 + nameLength + u16(at + 30) + u16(at + 32);
    const mode = u32(at + 38) >>> 16;
    const start = u32(at + 42);
    if (!within(at, recordLength) || at + recordLength > cdStart + cdSize) throw invalid("The zip's directory is damaged.");
    const nameBytes = zip.subarray(at + 46, at + 46 + nameLength);
    at += recordLength;

    let raw: string;
    try {
      raw = utf8.decode(nameBytes);
    } catch {
      throw invalid("A file name in the zip is not UTF-8. Zip it again with a tool that writes UTF-8 names.");
    }
    if (csize === FULL32 || size === FULL32 || start === FULL32) throw invalid(`${quoted(raw)} needs ZIP64, which is not accepted.`);
    if (flags & 0x41) throw invalid(`${quoted(raw)} is encrypted. Zip the site without a password.`);
    if (method !== 0 && method !== 8) throw invalid(`${quoted(raw)} uses compression method ${method}; only stored and deflate are accepted.`);

    const isDir = raw.endsWith("/");
    // A zip made from "." (macOS tar, `zip -r site.zip ./`) names its entries "./index.html": read them from the top.
    const name = raw.replace(/^(?:\.\/)+/, "");
    const topFolder = isDir && name === "";
    if (madeBy === UNIX && mode !== 0) {
      const type = mode & S_IFMT;
      if (type === S_IFLNK) throw invalid(`${quoted(raw)} is a symbolic link. A site holds regular files only.`);
      if (type !== S_IFREG && !(type === S_IFDIR && isDir) && type !== 0) throw invalid(`${quoted(raw)} is not a regular file.`);
    }
    const path = (isDir ? name.slice(0, -1) : name).normalize("NFC");
    if (!topFolder) checkPath(path, raw);

    // The local header must agree with the directory on method and name (its sizes and CRC may be zero, with the real
    // ones in a data descriptor after the bytes: flag bit 3), and the file's bytes must end before the directory.
    if (!within(start, 30) || u32(start) !== LOCAL) throw invalid(`${quoted(raw)} has no local header where the directory says.`);
    const localNameLength = u16(start + 26);
    const dataStart = start + 30 + localNameLength + u16(start + 28);
    const localName = zip.subarray(start + 30, start + 30 + localNameLength);
    if (u16(start + 8) !== method || localName.length !== nameBytes.length || !localName.every((b, k) => b === nameBytes[k])) {
      throw invalid(`${quoted(raw)}: its local header disagrees with the zip's directory.`);
    }
    if (dataStart + csize > cdStart) throw invalid(`${quoted(raw)} runs into the zip's directory.`);
    if (method === 0 && csize !== size) throw invalid(`${quoted(raw)} is stored, but its two sizes differ.`);

    const segments = path.split("/");
    const skip = isDir || segments[0] === "__MACOSX" || segments[segments.length - 1] === ".DS_Store";
    if (isDir && size !== 0) throw invalid(`${quoted(raw)} is a folder with content.`);
    found.push({ path, offset: dataStart, csize, size, method: method as 0 | 8, start, end: dataStart + csize, skip, crc });
  }
  if (at !== cdStart + cdSize) throw invalid("The zip's directory is damaged.");

  // No two entries may share bytes: overlapping entries are how a small zip claims a huge size.
  const byStart = [...found].sort((a, b) => a.start - b.start);
  for (let i = 1; i < byStart.length; i++) {
    if (byStart[i]!.start < byStart[i - 1]!.end) throw invalid(`${quoted(byStart[i]!.path)} and ${quoted(byStart[i - 1]!.path)} overlap in the zip.`);
  }

  let files = found.filter((e) => !e.skip);
  if (files.length > SITE_LIMITS.files) throw tooLarge(`A site has at most ${SITE_LIMITS.files} files; this one has ${files.length}.`);
  const seen = new Set<string>();
  let total = 0;
  for (const e of files) {
    if (seen.has(e.path)) throw invalid(`${quoted(e.path)} is in the zip twice.`);
    seen.add(e.path);
    if (e.size > SITE_LIMITS.fileBytes) throw tooLarge(`${quoted(e.path)} is ${e.size} bytes; a site's file is at most ${SITE_LIMITS.fileBytes}.`);
    total += e.size;
  }
  if (total > SITE_LIMITS.totalBytes) throw tooLarge(`A site holds at most ${SITE_LIMITS.totalBytes} bytes once unzipped; this one holds ${total}.`);

  // A zip of a folder puts everything under that folder's name: serve from inside it.
  if (!seen.has("index.html")) {
    const top = files[0]?.path.split("/")[0];
    if (top !== undefined && files.every((e) => e.path.startsWith(top + "/")) && seen.has(top + "/index.html")) {
      files = files.map((e) => ({ ...e, path: e.path.slice(top.length + 1) }));
    } else {
      throw invalid("A site needs an index.html at the top of the zip.");
    }
  }

  for (const e of files) await verifyBytes(zip.subarray(e.offset, e.offset + e.csize), e, e.crc);
  return files.map(({ path, offset, csize, size, method }) => ({ path, offset, csize, size, method }));
}

function checkPath(path: string, raw: string): void {
  if (path.includes("\\")) throw invalid(`${quoted(raw)} has a backslash in its path. Use / between folders.`);
  if (/[\u0000-\u001f\u007f]/.test(path)) throw invalid(`${quoted(raw)} has a control character in its name.`);
  if (enc.encode(path).length > SITE_LIMITS.pathBytes) throw invalid(`${quoted(raw)} is too long: a path is at most ${SITE_LIMITS.pathBytes} bytes.`);
  if (path.startsWith("/") || path.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw invalid(`${quoted(raw)} points outside the site, or has an empty, "." or ".." part.`);
  }
}

/**
 * The site path a request asks for, from the URL path after the Version's prefix (still percent-encoded), or null.
 * Each segment is decoded on its own and must then pass the zip's own path rules, so an encoded slash, backslash or
 * dot segment is refused exactly as in a zip. A path that ends in a slash, or is empty, asks for that folder's index.html.
 */
export function siteRequestPath(rest: string): string | null {
  const parts = rest.split("/");
  if (parts[parts.length - 1] === "") parts[parts.length - 1] = "index.html";
  let decoded: string[];
  try {
    decoded = parts.map((p) => decodeURIComponent(p));
  } catch {
    return null;
  }
  if (decoded.some((p) => p.includes("/"))) return null;
  const path = decoded.join("/").normalize("NFC");
  try {
    checkPath(path, path);
  } catch {
    return null;
  }
  return path;
}

/**
 * Reads a file once, inflating it when deflated, and refuses it unless it comes out at exactly its declared size and
 * CRC. The inflater must reach the end of the deflate stream with nothing after it.
 */
async function verifyBytes(stored: Uint8Array, e: SiteEntry, crc: number): Promise<void> {
  let out = 0;
  let sum = 0xffffffff;
  try {
    const body = new Blob([stored]).stream();
    const reader = (e.method === 8 ? body.pipeThrough(new DecompressionStream("deflate-raw")) : body).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += value.byteLength;
      if (out > e.size) {
        await reader.cancel();
        break;
      }
      sum = crc32(sum, value);
    }
  } catch {
    throw invalid(`${quoted(e.path)} is damaged: it does not inflate.`);
  }
  if (out !== e.size) throw invalid(`${quoted(e.path)} says it is ${e.size} bytes but is not.`);
  if ((sum ^ 0xffffffff) >>> 0 !== crc) throw invalid(`${quoted(e.path)} is damaged: its checksum does not match.`);
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(sum: number, bytes: Uint8Array): number {
  let c = sum;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return c >>> 0;
}

/** A stored file's bytes as served: inflated when deflated, and never longer than its proven size. */
export function entryStream(stored: ReadableStream<Uint8Array>, e: SiteEntry): ReadableStream<Uint8Array> {
  if (e.method === 0) return stored;
  let left = e.size;
  return stored.pipeThrough(new DecompressionStream("deflate-raw")).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, out) {
      if (chunk.byteLength > left) {
        out.error(new Error("a site file inflated past its size"));
        return;
      }
      left -= chunk.byteLength;
      out.enqueue(chunk);
    },
  }));
}
