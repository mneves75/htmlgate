// The Publisher API client, on global fetch: no redirects are followed, every request has a deadline, and every
// answer must be JSON of the expected shape before anything trusts it.
import { CliError, exitCodeFor } from "./errors.js";
import type { Content } from "./files.js";
import { userAgent } from "./useragent.js";

const TIMEOUT_MS = 30_000;
// Every API answer is small JSON. Past this the server is not the API, and the CLI stops reading instead of filling memory.
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

/** The fields a publish or a PATCH may carry besides its content. `expires_at` null is never. */
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

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// Checks every field the CLI prints or decides on, so a wrong answer is a bad_response rather than a crash.
function asShare(v: unknown): Share {
  if (!isObj(v) || typeof v.slug !== "string" || typeof v.url !== "string" || typeof v.title !== "string" || typeof v.public !== "boolean" || !isTime(v.updated_at)) {
    throw badShape("a Share");
  }
  return v as unknown as Share;
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
    // Leaving the loop early cancels the stream, so an oversized answer stops downloading here.
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

  /** POST: a new Share with its first Version, a page or a site. */
  publish(content: Content, fields: Fields & { title: string }): Promise<Share> {
    return this.send("POST", "/api/shares", content, fields).then(asShare);
  }

  getShare(slug: string): Promise<Share> {
    return this.call("GET", `/api/shares/${encodeURIComponent(slug)}`).then(asShare);
  }

  /** PUT: a new Version, a page or a site. Metadata, when present, replaces the whole map. */
  replace(slug: string, content: Content, fields: Fields): Promise<Share> {
    return this.send("PUT", `/api/shares/${encodeURIComponent(slug)}`, content, fields).then(asShare);
  }
  /** A page goes as JSON; a site goes as its zip, with the fields in the query string. */
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

  /** PATCH: fields only, no new Version. `metadata: {}` clears the map. */
  patch(slug: string, body: Fields): Promise<Share> {
    return this.call("PATCH", `/api/shares/${encodeURIComponent(slug)}`, body).then(asShare);
  }

  async remove(slug: string): Promise<void> {
    await this.call("DELETE", `/api/shares/${encodeURIComponent(slug)}`);
  }

  setPublic(slug: string, isPublic: boolean): Promise<Share> {
    return this.call("POST", `/api/shares/${encodeURIComponent(slug)}/visibility`, { public: isPublic }).then(asShare);
  }

  async listShares(q: { page?: number; pageSize?: number; metadata?: Record<string, string>; public?: boolean } = {}): Promise<SharePage> {
    const qs = new URLSearchParams();
    if (q.page) qs.set("page", String(q.page));
    if (q.pageSize) qs.set("pageSize", String(q.pageSize));
    qs.set("sortBy", "updated_at");
    if (q.public !== undefined) qs.set("public", String(q.public));
    for (const [k, v] of Object.entries(q.metadata ?? {})) qs.append(`metadata.${k}`, v);
    const body = await this.call("GET", `/api/shares?${qs}`);
    if (!isObj(body) || !Array.isArray(body.data) || !isObj(body.pagination) || typeof body.pagination.total_pages !== "number") {
      throw badShape("a list of Shares");
    }
    const total = typeof body.pagination.total === "number" ? body.pagination.total : body.data.length;
    return { data: body.data.map(asShare), total, totalPages: body.pagination.total_pages };
  }

  async versions(slug: string): Promise<Version[]> {
    const body = await this.call("GET", `/api/shares/${encodeURIComponent(slug)}/versions`);
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

  /** `body`: JSON, or a zip's bytes. */
  private async call(method: Method, path: string, body?: unknown): Promise<unknown> {
    const zip = body instanceof Uint8Array ? body : undefined;
    const url = this.origin + path;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "user-agent": userAgent(),
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { "content-type": zip ? "application/zip" : "application/json" } : {}),
        },
        ...(body !== undefined ? { body: zip ?? JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new CliError("network_error", `Could not reach ${this.origin}.`, { cause: e });
    }
    // A redirect would carry the request, and with it the token, somewhere this CLI was never pointed at.
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
      // Without the API's envelope (a proxy's page, say), the status still says what kind of failure it was.
      let code = typeof err?.code === "string" ? err.code : (STATUS_CODES[res.status] ?? (res.status >= 500 ? "server_error" : "bad_response"));
      // Any server failure exits 8, whatever name the server gave it.
      if (res.status >= 500 && exitCodeFor(code) === 1) code = "server_error";
      const message = typeof err?.message === "string" ? err.message : `HTTP ${res.status}`;
      throw new CliError(code, message, { details: { status: res.status } });
    }
    if (parsed === undefined) throw badShape("JSON");
    return parsed;
  }
}
