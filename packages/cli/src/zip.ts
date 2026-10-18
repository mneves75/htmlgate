// Writing a site's zip from a folder's files, in memory. Each file is deflated unless that would not make
// it smaller; names are UTF-8 (flag bit 11) and every entry is a regular file, so the Instance's checks
// (src/zip.ts in the Worker) accept what this writes. Times are fixed, so the same files give the same zip.
import { crc32, deflateRawSync } from "node:zlib";

/** The Instance's limits for a site (src/zip.ts there), checked here before anything is sent. */
export const SITE_LIMITS = {
  zipBytes: 10 * 1024 * 1024,
  files: 1000,
  fileBytes: 5 * 1024 * 1024,
  totalBytes: 25 * 1024 * 1024,
} as const;

export interface ZipFile {
  path: string;
  data: Uint8Array;
}

const UTF8_NAMES = 0x0800;
const MADE_BY_UNIX = (3 << 8) | 20;
const REGULAR_FILE = (0o100644 << 16) >>> 0;
const DOS_DATE_1980 = (0 << 9) | (1 << 5) | 1;

export function writeZip(files: ZipFile[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const deflated = deflateRawSync(f.data);
    const method = deflated.length < f.data.length ? 8 : 0;
    const body = method === 8 ? deflated : f.data;
    const crc = crc32(f.data);

    const local = new Uint8Array(30 + name.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, UTF8_NAMES, true);
    lv.setUint16(8, method, true);
    lv.setUint16(12, DOS_DATE_1980, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, MADE_BY_UNIX, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, UTF8_NAMES, true);
    cv.setUint16(10, method, true);
    cv.setUint16(14, DOS_DATE_1980, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, REGULAR_FILE, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const zip = new Uint8Array(offset + cdSize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    zip.set(part, at);
    at += part.length;
  }
  return zip;
}
