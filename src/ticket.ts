// Tickets (plan 009): a site's files are fetched by a Share running in an opaque origin, so its requests
// never carry the Access cookie. The Worker, after verifying a person's Access token, issues a ticket:
// AES-GCM sealed under the Instance's TICKET_KEY, naming one Version of one Share, that person and an
// expiry. Sealed, not signed, so a Share's scripts reading their own URL cannot learn who is viewing.
import { EMAIL, SLUG } from "./ids";
// A ticket proves only that it was issued; every request still checks the Allowlist and the Share.

export const TICKET_TTL_MS = 60 * 60 * 1000;

export interface Ticket {
  slug: string;
  n: number;
  email: string;
  exp: number;
}

/** The TICKET_KEY secret: 32 bytes as unpadded base64url. */
export const TICKET_KEY_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const SEALED = /^[A-Za-z0-9_-]{40,1024}$/;
// What a ticket is for, and which Instance sealed it (its Access audience), bound into the seal.
const aad = (aud: string) => new TextEncoder().encode(`htmlgate ticket 1 ${aud}`);

/** A ticket key as setup makes it: exactly 32 bytes as canonical, unpadded base64url. Synchronous, for readConfig. */
export function isTicketKey(raw: string): boolean {
  return TICKET_KEY_FORMAT.test(raw) && fromBase64url(raw)?.length === 32;
}

/** The Instance's ticket key from its secret, or null when the secret is not one. */
export async function importTicketKey(raw: string): Promise<CryptoKey | null> {
  if (!isTicketKey(raw)) return null;
  return crypto.subtle.importKey("raw", fromBase64url(raw)!, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealTicket(key: CryptoKey, aud: string, t: Ticket): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify([t.slug, t.n, t.email, t.exp]));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(aud) }, key, plain));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return toBase64url(out);
}

/** What an authentic ticket says, expired or not; null for anything this Instance did not seal. */
export async function openTicket(key: CryptoKey, aud: string, sealed: string): Promise<Ticket | null> {
  if (!SEALED.test(sealed)) return null;
  const bytes = fromBase64url(sealed);
  if (!bytes || bytes.length < 12 + 16) return null;
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: aad(aud) }, key, bytes.subarray(12));
  } catch {
    return null;
  }
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
  if (!Array.isArray(v) || v.length !== 4) return null;
  const [slug, n, email, exp] = v as unknown[];
  if (typeof slug !== "string" || !SLUG.test(slug) || typeof email !== "string" || !EMAIL.test(email)) return null;
  if (!Number.isSafeInteger(n) || (n as number) < 1 || !Number.isSafeInteger(exp)) return null;
  return { slug, n: n as number, email, exp: exp as number };
}

function toBase64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Canonical only: a string whose unused trailing bits are not zero would name the same bytes twice. */
function fromBase64url(s: string): Uint8Array | null {
  if (s.length % 4 === 1) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  return toBase64url(bytes) === s ? bytes : null;
}
