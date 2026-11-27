import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config } from "./config";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keys(teamUrl: string) {
  let set = keySets.get(teamUrl);
  if (!set) {
    set = createRemoteJWKSet(new URL(`${teamUrl}/cdn-cgi/access/certs`));
    keySets.set(teamUrl, set);
  }
  return set;
}

const CALLER_CAUSED = /^ERR_(JWT_|JWS_|JOSE_ALG_NOT_ALLOWED$|JOSE_NOT_SUPPORTED$|JWKS_NO_MATCHING_KEY$|JWKS_MULTIPLE_MATCHING_KEYS$)/;

/**
 * The signed-in person on the Allowlist and when Access issued their sign-in (ms; 0 without an iat), or null.
 * Only a verified Cf-Access-Jwt-Assertion counts. ctx.access, cookies and unverified headers can all be
 * present without a sign-in on Access's public paths (issue #18), so none of them is read.
 */
const MAX_JWT_BYTES = 8192;

export type Person = { email: string; issuedAt: number };

export async function person(req: Request, cfg: Config): Promise<Person | null> {
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token || token.length > MAX_JWT_BYTES) return null;
  try {
    const { payload } = await jwtVerify(token, keys(cfg.teamUrl), {
      issuer: cfg.teamUrl,
      audience: cfg.aud,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "email"],
    });
    if (payload.type !== undefined && payload.type !== "app") return null;
    // Fold only ASCII: trim() and toLowerCase() are Unicode-wide, so they would turn other legal mailboxes
    // (U+212A KELVIN SIGN, NBSP around the address) into an Allowlisted one.
    const email = typeof payload.email === "string" ? payload.email.replace(/^[ \t]+|[ \t]+$/g, "").replace(/[A-Z]/g, (c) => c.toLowerCase()) : "";
    // jose has checked that iat, when present, is a number. Without one the sign-in counts as issued at 0, the oldest.
    return cfg.allowlist.has(email) ? { email, issuedAt: typeof payload.iat === "number" ? payload.iat * 1000 : 0 } : null;
  } catch (e) {
    const code = String((e as { code?: unknown } | null)?.code ?? "");
    if (!CALLER_CAUSED.test(code)) {
      console.error("access", code || (e instanceof Error ? e.name : "error"), e instanceof Error ? e.message : "");
    }
    return null;
  }
}
