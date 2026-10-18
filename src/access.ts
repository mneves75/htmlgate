import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config } from "./config";

// Signing keys are public and rotate slowly, so a per-isolate key set is safe to keep.
// Identity is never cached: every request verifies its own token.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keys(teamUrl: string) {
  let set = keySets.get(teamUrl);
  if (!set) {
    set = createRemoteJWKSet(new URL(`${teamUrl}/cdn-cgi/access/certs`));
    keySets.set(teamUrl, set);
  }
  return set;
}

// jose's codes for a token that is malformed, unsigned by these keys, out of date, for another audience, of an
// algorithm or with a header this Instance does not take, or naming a key the team does not have.
const CALLER_CAUSED = /^ERR_(JWT_|JWS_|JOSE_ALG_NOT_ALLOWED$|JOSE_NOT_SUPPORTED$|JWKS_NO_MATCHING_KEY$|JWKS_MULTIPLE_MATCHING_KEYS$)/;

/**
 * The signed-in person on the Allowlist, or null.
 * Only a verified Cf-Access-Jwt-Assertion counts. ctx.access, cookies and unverified headers can all be
 * present without a sign-in on Access's public paths (issue #18), so none of them is read.
 */
export async function person(req: Request, cfg: Config): Promise<string | null> {
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, keys(cfg.teamUrl), {
      issuer: cfg.teamUrl,
      audience: cfg.aud,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "email"],
    });
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    return cfg.allowlist.has(email) ? email : null;
  } catch (e) {
    // A refusal the token itself causes is ordinary, and anyone can send a token (a forged one too, on a public
    // path), so none of those is logged. What is left is the certs endpoint failing: unreachable, slow, or not
    // answering with keys. Then nobody can sign in, so it is logged, by code and message, never the token.
    const code = String((e as { code?: unknown } | null)?.code ?? "");
    if (!CALLER_CAUSED.test(code)) {
      console.error("access", code || (e instanceof Error ? e.name : "error"), e instanceof Error ? e.message : "");
    }
    return null;
  }
}
