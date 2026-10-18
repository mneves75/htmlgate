// Independent reviewer's helpers. Everything here is built from the stated requirements, not from src/.
import { inject } from "vitest";
import { base64url, importJWK, SignJWT } from "jose";
import { AUD } from "./global-setup";
import { api, base, mintToken } from "./helpers";

export const teamUrl = inject("teamUrl");
const privateJwk = JSON.parse(inject("privateJwk"));
const keyPromise = importJWK(privateJwk, "RS256");

export const b64 = (o: unknown) => base64url.encode(new TextEncoder().encode(JSON.stringify(o)));

export function claims(email: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { email, type: "app", iss: teamUrl, aud: [AUD], iat: now, nbf: now - 5, exp: now + 3600, sub: "sub", ...over };
}

/** A validly signed token with exactly the claims given (so a claim can be left out). */
export async function signed(c: Record<string, unknown>, header: Record<string, unknown> = {}) {
  return new SignJWT(c as never).setProtectedHeader({ alg: "RS256", kid: "test-key", ...header } as never).sign(await keyPromise);
}

/** The public half of the signing key, which an attacker can read from the certs endpoint. */
export const publicJwk = { kty: privateJwk.kty, n: privateJwk.n as string, e: privateJwk.e as string, kid: "test-key" };

export async function get(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, { redirect: "manual", ...init });
  return { status: res.status, headers: res.headers, body: await res.text() };
}
export type Res = Awaited<ReturnType<typeof get>>;

export const jwtHeader = (jwt: string): RequestInit => ({ headers: { "cf-access-jwt-assertion": jwt } });

/** Everything a person could compare between two answers, with the slug swapped out of the body. */
export function full(r: Res, slug?: string) {
  const headers = [...r.headers].filter(([k]) => k !== "date").sort(([a], [b]) => a.localeCompare(b));
  return { status: r.status, headers, body: slug ? r.body.replaceAll(slug, "SLUG") : r.body };
}

export const MISSING = "ZZZZZZZZZZZZ";

export async function newCaller(name: string) {
  const token = await mintToken(name);
  return { token, call: api(token) };
}
