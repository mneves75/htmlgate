const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Uniform random letters and digits, by rejection sampling so no character is favoured. */
export function randomAlnum(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < 248 && out.length < length) out += ALPHABET[b % 62];
    }
  }
  return out;
}

export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const SLUG = /^[A-Za-z0-9]{12}$/;
export const EMAIL = /^[^\s@,]+@[^\s@,]+$/;
export const TOKEN_ID = /^[0-9a-f]{12}$/;
/** A Version number or a page number: a plain decimal from 1, small enough for D1. */
export const POSITIVE = /^[1-9][0-9]{0,8}$/;
export const TOKEN = /^hg_[A-Za-z0-9]{40}$/;
export const newSlug = () => randomAlnum(12);
export const newToken = () => "hg_" + randomAlnum(40);
