import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { inject } from "vitest";
import { importJWK, SignJWT } from "jose";
import { AUD, AUTHOR } from "./global-setup";

export const base = inject("base");
const teamUrl = inject("teamUrl");
const keyPromise = importJWK(JSON.parse(inject("privateJwk")), "RS256");

/** A signed Access application token, as Cloudflare Access would put in Cf-Access-Jwt-Assertion. */
export async function accessJwt(email: string, over: { aud?: string; iss?: string; exp?: number; key?: CryptoKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(over.iss ?? teamUrl)
    .setAudience([over.aud ?? AUD])
    .setIssuedAt(now)
    .setNotBefore(now - 5)
    .setExpirationTime(over.exp ?? now + 3600)
    .setSubject("sub-" + email)
    .sign(over.key ?? (await keyPromise));
}

export async function asPerson(email: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cf-access-jwt-assertion", await accessJwt(email));
  return { ...init, headers };
}

/** Creates a token through the Author's token page, the way a person does. `at` is the Instance. */
export async function mintToken(name = "test", at = base): Promise<string> {
  const res = await fetch(`${at}/tokens`, await asPerson(AUTHOR, {
    method: "POST",
    headers: { origin: at, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name }).toString(),
  }));
  const html = await res.text();
  const m = /<code id="new-token">(hg_[A-Za-z0-9]+)<\/code>/.exec(html);
  if (res.status !== 200 || !m) throw new Error(`could not mint a token: ${res.status} ${html.slice(0, 300)}`);
  return m[1]!;
}

export function api(token: string | null, at = base) {
  return async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { "user-agent": "htmlgate-tests" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${at}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any = undefined;
    try { json = text ? JSON.parse(text) : undefined; } catch {}
    return { status: res.status, json, headers: res.headers, text };
  };
}

export const page = (html: string) => `<!doctype html><title>t</title><p>${html}</p>`;

const state = inject("state");
const WRANGLER = join(process.cwd(), "node_modules/.bin/wrangler");

/** Runs SQL on the shared Instance's local D1, as the Operator could with `wrangler d1 execute`, and returns the rows. */
export async function localSql(command: string): Promise<Record<string, unknown>[]> {
  const { stdout } = await promisify(execFile)(WRANGLER, ["d1", "execute", "htmlgate-dev", "--local", "--persist-to", state, "--json", "--command", command],
    { env: { ...process.env, CI: "1" } });
  return JSON.parse(stdout)[0].results;
}

/** How many objects the shared Instance's local R2 holds. */
export function localObjects(): number {
  const r2 = join(state, "v3", "r2");
  if (!existsSync(r2)) return 0;
  let n = 0;
  for (const bucket of readdirSync(r2)) {
    const blobs = join(r2, bucket, "blobs");
    if (existsSync(blobs)) n += readdirSync(blobs).length;
  }
  return n;
}

/** The htmlgate CLI, built from packages/cli by the global setup. */
export const CLI = join(process.cwd(), "packages/cli/dist/bin.js");

export interface CliResult { code: number; out: any; stdout: string; stderr: string }

/** Runs the CLI with `--output json` in `cwd`, with only the environment given (HOME isolates the global config). */
export async function htmlgate(cwd: string, env: Record<string, string>, args: string[], input?: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, "--output", "json", ...args], { cwd, env: { PATH: process.env.PATH!, NO_COLOR: "1", ...env } },
      (err, stdout, stderr) => {
        let out: any = undefined;
        try { out = stdout.trim() ? JSON.parse(stdout) : undefined; } catch {}
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
        resolve({ code, out, stdout, stderr });
      });
    child.stdin!.end(input ?? "");
  });
}
