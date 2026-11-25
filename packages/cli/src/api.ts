import { CliError, exitCodeFor } from "./errors.js";
import type { Content } from "./files.js";
import { userAgent } from "./useragent.js";

const TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const STATUS_CODES: Record<number, string> = { 401: "unauthorized", 403: "forbidden", 404: "not_found", 413: "html_too_large", 429: "rate_limited" };

export interface Share {
  slug: string;
  title: string;
  description: string | null;
  url: string;
  public: boolean;
  latest_version: number;
  metadata: Record<string, string>;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
}

export interface Fields {
  title?: string;
  description?: string;
  metadata?: Record<string, string>;
  expires_at?: number | null;
}

export interface SharePage {
  data: Share[];
  total: number;
  totalPages: number;
}

export interface Version {
  n: number;
  kind: "page" | "site";
  size: number;
  created_at: number;
  token: { id: string | null; name: string | null };
}

export interface Token {
  id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const MAX_TIME_MS = 8.64e15;
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_TIME_MS;

const UNSAFE_URL_CHARS = /[\s\\\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const HTTP_ORIGIN = /^https?:\/\//i;

function normalizeShareUrl(raw: string, origin: string): string | null {
  if (!raw || UNSAFE_URL_CHARS.test(raw) || raw.startsWith("//")) return null;
  const absolute = HTTP_ORIGIN.test(raw);
  if (!absolute && !raw.startsWith("/")) return null;
  let u: URL;
  let base: URL;
  try {
    base = new URL(origin);
    u = absolute ? new URL(raw) : new URL(raw, base);
  } catch {
    return null;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) return null;
  if (u.origin !== base.origin) return null;
  return u.href;
}

function asShare(v: unknown, origin: string): Share {
  if (!isObj(v) || typeof v.slug !== "string" || typeof v.url !== "string" || typeof v.title !== "string" || typeof v.public !== "boolean" || !isTime(v.updated_at)) {
    throw badShape("a Share");
  }
  if (v.expires_at !== undefined && v.expires_at !== null && !isTime(v.expires_at)) throw badShape("a Share");
  const normalized = normalizeShareUrl(v.url, origin);
  if (normalized === null) {
    throw new CliError("bad_response", `The Instance returned an unexpected Share URL: ${v.url}`);
  }
  return { ...(v as unknown as Share), url: normalized };
}

function safeSlugPath(slug: string): string {
  if (!slug || slug === "." || slug === "..") throw new CliError("invalid_slug", `"${slug}" is not a valid Share slug.`);
  return encodeURIComponent(slug);
}

function badShape(what: string): CliError {
  return new CliError("bad_response", `The Instance did not answer with ${what}.`, {
    hint: "Check that the URL is your htmlgate Instance and not a page in front of it.",
  });
}

async function readBounded(res: Response, origin: string): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of res.body ?? []) {
      size += chunk.byteLength;
      if (size > MAX_RESPONSE_BYTES) break;
      chunks.push(chunk);
    }
  } catch (e) {
    throw new CliError("network_error", `${origin} stopped answering mid-response.`, { cause: e });
  }
  if (size > MAX_RESPONSE_BYTES) throw new CliError("bad_response", `${origin} sent more than ${MAX_RESPONSE_BYTES} bytes, which no API answer needs.`);
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export class InstanceApi {
  constructor(private readonly origin: string, private readonly token: string) {}

  publish(content: Content, fields: Fields & { title: string }): Promise<Share> {
    return this.send("POST", "/api/shares", content, fields).then((v) => asShare(v, this.origin));
  }

  getShare(slug: string): Promise<Share> {
    return this.call("GET", `/api/shares/${safeSlugPath(slug)}`).then((v) => asShare(v, this.origin));
  }

  replace(slug: string, content: Content, fields: Fields): Promise<Share> {
    return this.send("PUT", `/api/shares/${safeSlugPath(slug)}`, content, fields).then((v) => asShare(v, this.origin));
  }

  private send(method: "POST" | "PUT", path: string, content: Content, fields: Fields): Promise<unknown> {
    if (content.kind === "page") return this.call(method, path, { html: content.html, ...fields });
    const qs = new URLSearchParams();
    if (fields.title !== undefined) qs.set("title", fields.title);
    if (fields.description !== undefined) qs.set("description", fields.description);
    for (const [k, v] of Object.entries(fields.metadata ?? {})) qs.set(`metadata.${k}`, v);
    if (fields.expires_at !== undefined) qs.set("expires_at", fields.expires_at === null ? "never" : String(fields.expires_at));
    const query = qs.toString();
    return this.call(method, query ? `${path}?${query}` : path, content.zip);
  }

  patch(slug: string, body: Fields): Promise<Share> {
    return this.call("PATCH", `/api/shares/${safeSlugPath(slug)}`, body).then((v) => asShare(v, this.origin));
  }

  async remove(slug: string): Promise<void> {
    await this.call("DELETE", `/api/shares/${safeSlugPath(slug)}`);
  }

  setPublic(slug: string, isPublic: boolean): Promise<Share> {
    return this.call("POST", `/api/shares/${safeSlugPath(slug)}/visibility`, { public: isPublic }).then((v) => asShare(v, this.origin));
  }

  async listShares(q: { page?: number; pageSize?: number; metadata?: Record<string, string>; public?: boolean } = {}): Promise<SharePage> {
    const qs = new URLSearchParams();
    if (q.page) qs.set("page", String(q.page));
    if (q.pageSize) qs.set("pageSize", String(q.pageSize));
    qs.set("sortBy", "updated_at");
    if (q.public !== undefined) qs.set("public", String(q.public));
    for (const [k, v] of Object.entries(q.metadata ?? {})) qs.append(`metadata.${k}`, v);
    const body = await this.call("GET", `/api/shares?${qs}`);
    if (!isObj(body) || !Array.isArray(body.data) || !isObj(body.pagination)
      || typeof body.pagination.total_pages !== "number" || !Number.isSafeInteger(body.pagination.total_pages) || body.pagination.total_pages < 0) {
      throw badShape("a list of Shares");
    }
    const total = typeof body.pagination.total === "number" && Number.isSafeInteger(body.pagination.total) && body.pagination.total >= 0
      ? body.pagination.total
      : body.data.length;
    return { data: body.data.map((v) => asShare(v, this.origin)), total, totalPages: body.pagination.total_pages };
  }

  async versions(slug: string): Promise<Version[]> {
    const body = await this.call("GET", `/api/shares/${safeSlugPath(slug)}/versions`);
    if (!isObj(body) || !Array.isArray(body.data) || !body.data.every((v) => isObj(v) && typeof v.n === "number" && typeof v.size === "number" && isTime(v.created_at) && isObj(v.token) && (v.token.name === null || typeof v.token.name === "string"))) {
      throw badShape("a list of Versions");
    }
    return body.data as Version[];
  }

  async tokens(): Promise<Token[]> {
    const body = await this.call("GET", "/api/tokens");
    if (!isObj(body) || !Array.isArray(body.data) || !body.data.every((t) => isObj(t) && typeof t.id === "string" && typeof t.name === "string" && (t.last_used_at == null || isTime(t.last_used_at)))) {
      throw badShape("a list of tokens");
    }
    return body.data as Token[];
  }

  async revokeToken(id: string): Promise<void> {
    await this.call("DELETE", `/api/tokens/${encodeURIComponent(id)}`);
  }

  private async call(method: Method, path: string, body?: unknown): Promise<unknown> {
    const zip = body instanceof Uint8Array ? body : undefined;
    const url = this.origin + path;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        ...(body !== undefined ? { body: zip ?? JSON.stringify(body) } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "user-agent": userAgent(),
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { "content-type": zip ? "application/zip" : "application/json" } : {}),
        },
      });
    } catch (e) {
      throw new CliError("network_error", `Could not reach ${this.origin}.`, { cause: e });
    }
    if (res.status >= 300 && res.status < 400) {
      throw new CliError("redirected", `${this.origin} answered with a redirect (HTTP ${res.status}). The CLI does not follow redirects.`, {
        hint: "Use the Instance's own address. A redirect to a sign-in page means the URL is not the Instance's API.",
      });
    }
    if (res.status === 204) return undefined;
    const text = await readBounded(res, this.origin);
    let parsed: unknown;
    try {
      parsed = (res.headers.get("content-type") ?? "").includes("application/json") ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (res.status >= 400) {
      const err = isObj(parsed) && isObj(parsed.error) ? parsed.error : undefined;
      let code = typeof err?.code === "string" ? err.code : (STATUS_CODES[res.status] ?? (res.status >= 500 ? "server_error" : "bad_response"));
      if (res.status >= 500 && exitCodeFor(code) === 1) code = "server_error";
      const message = typeof err?.message === "string" ? err.message : `HTTP ${res.status}`;
      throw new CliError(code, message, { details: { status: res.status } });
    }
    if (parsed === undefined) throw badShape("JSON");
    return parsed;
  }
}
