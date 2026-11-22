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
    const code = String((e as { code?: unknown } | null)?.code ?? "");
    if (!CALLER_CAUSED.test(code)) {
      console.error("access", code || (e instanceof Error ? e.name : "error"), e instanceof Error ? e.message : "");
    }
    return null;
  }
}
