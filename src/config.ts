import { EMAIL } from "./ids";
import { isTicketKey } from "./ticket";

export interface Env {
  DB: D1Database;
  BODIES: R2Bucket;
  /** Without it the API refuses every change (src/api.ts). */
  WRITE_LIMIT?: RateLimit;
  ACCESS_TEAM_URL?: string;
  ACCESS_AUD?: string;
  AUTHOR_EMAIL?: string;
  ALLOWLIST?: string;
  STORAGE_LIMIT_BYTES?: string;
  /** The language of the Instance's own pages: "en" (the default) or "pt-BR". */
  LANGUAGE?: string;
  TICKET_KEY?: string;
  EXPIRY_DAYS?: string;
}

export type Language = "en" | "pt-BR";

export interface Config {
  teamUrl: string;
  aud: string;
  author: string;
  /** Lowercased emails allowed to open Gated Shares. Always contains the Author. */
  allowlist: Set<string>;
  storageLimit: number;
  language: Language;
  /** Seals tickets for a Gated site's files (src/ticket.ts): 43 base64url characters, a Worker secret. */
  ticketKey: string;
  /** Days a Share lives after its latest publish unless a Publisher sets a date; 0 means never. */
  expiryDays: number;
}

// R2's free allowance is 10 GB-month; leave room for the rest of the account.
const DEFAULT_STORAGE_LIMIT = 5 * 1000 * 1000 * 1000;
const DEFAULT_EXPIRY_DAYS = 30;
const MAX_EXPIRY_DAYS = 3650;
// The signing keys come from here, so plain http is allowed only for a test server on this machine.
const TEAM_URL = /^(https:\/\/[^/]+|http:\/\/(127\.0\.0\.1|localhost)(:[0-9]+)?)$/;

/** Reads the Instance's settings. Returns null when any is missing or malformed, so callers fail closed. */
export function readConfig(env: Env): Config | null {
  const teamUrl = env.ACCESS_TEAM_URL?.trim().replace(/\/+$/, "");
  const aud = env.ACCESS_AUD?.trim();
  const author = env.AUTHOR_EMAIL?.trim().toLowerCase();
  if (!teamUrl || !TEAM_URL.test(teamUrl) || !aud || !author || !EMAIL.test(author)) return null;
  const allowlist = new Set<string>([author]);
  for (const raw of (env.ALLOWLIST ?? "").split(",")) {
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    if (!EMAIL.test(e)) return null;
    allowlist.add(e);
  }
  const limit = env.STORAGE_LIMIT_BYTES ? Number(env.STORAGE_LIMIT_BYTES) : DEFAULT_STORAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0) return null;
  const language = env.LANGUAGE ?? "en";
  if (language !== "en" && language !== "pt-BR") return null;
  const ticketKey = env.TICKET_KEY?.trim() ?? "";
  if (!isTicketKey(ticketKey)) return null;
  const rawDays = env.EXPIRY_DAYS?.trim();
  const expiryDays = rawDays ? Number(rawDays) : DEFAULT_EXPIRY_DAYS;
  if (!/^[0-9]+$/.test(rawDays ?? "0") || !Number.isSafeInteger(expiryDays) || expiryDays < 0 || expiryDays > MAX_EXPIRY_DAYS) return null;
  return { teamUrl, aud, author, allowlist, storageLimit: limit, language, ticketKey, expiryDays };
}
