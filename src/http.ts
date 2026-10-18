/** Headers on every response the Instance makes. */
const BASE: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  // Our own pages send their address to themselves only. A form POST under no-referrer carries
  // Origin: null, which the token page would refuse (found in a real browser on staging).
  "referrer-policy": "same-origin",
  // A year, for this host only: the Operator's domain may have other hosts that are not https.
  "strict-transport-security": "max-age=31536000",
};

export function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE, "content-type": "application/json; charset=utf-8", "content-security-policy": "default-src 'none'; frame-ancestors 'none'", ...extra },
  });
}

/** The error envelope; the htmlgate CLI (packages/cli) maps its codes to exit codes. */
export function fail(status: number, code: string, message: string, extra: Record<string, string> = {}): Response {
  return json(status, { error: { code, message } }, extra);
}

export function redirect(location: string, status: 301 | 303 = 303): Response {
  return new Response(null, { status, headers: { ...BASE, location } });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: BASE });
}

export function text(status: number, body: string, contentType: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...BASE, "content-type": contentType, ...extra } });
}

/** A streamed body (a site's file, a Version's zip) with the headers every response carries. */
export function stream(body: ReadableStream<Uint8Array>, contentType: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { ...BASE, "content-type": contentType, ...extra } });
}

// A site's file is served with a type from this table and nothing else, so a file cannot choose how a browser treats
// it. Text is UTF-8; anything unknown is a download. (`nosniff` is on every response.)
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8", xml: "application/xml; charset=utf-8", svg: "image/svg+xml; charset=utf-8",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  ico: "image/x-icon", bmp: "image/bmp", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", mp4: "video/mp4", webm: "video/webm", pdf: "application/pdf",
  wasm: "application/wasm",
};

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot > path.lastIndexOf("/") ? path.slice(dot + 1).toLowerCase() : "";
  return TYPES[ext] ?? "application/octet-stream";
}

/**
 * The request body as text, or null when it is over `max` bytes. It stops reading at the cap, so a larger body
 * is refused before it fills memory; leaving the loop early cancels the stream.
 */
export async function readCapped(req: Request, max: number): Promise<string | null> {
  const bytes = await readCappedBytes(req, max);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

/** The request body's bytes, or null when it is over `max`; it stops reading at the cap. */
export async function readCappedBytes(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req.body ?? []) {
    size += chunk.byteLength;
    if (size > max) return null;
    chunks.push(chunk);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return all;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
