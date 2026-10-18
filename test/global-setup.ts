// Starts the real Worker under `wrangler dev` with a fresh local D1, and a stand-in for the
// Access team's certs endpoint, so the Worker's JWT check runs exactly as deployed.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK } from "jose";
import type { TestProject } from "vitest/node";

export const AUD = "test-aud-0123456789abcdef";
export const AUTHOR = "author@example.com";
export const VIEWER = "viewer@example.com";
export const STORAGE_LIMIT = 64 * 1024 * 1024;
/** The test Instances' ticket key (a Worker secret in a real Instance). Tests seal their own tickets with it. */
export const TICKET_KEY = "arx_oqk_HfZgIDMwWmF-0MNZrk_azyzkLwZL6MlJO3A";

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

export interface Instance {
  base: string;
  /** The local D1 directory, for the Operator's token command. */
  state: string;
  stop: () => Promise<void>;
}

const WRANGLER = join(process.cwd(), "node_modules/.bin/wrangler");
const cleanState = (state: string) => rmSync(state, { recursive: true, force: true, maxRetries: 3 });

/** Runs the real Worker under `wrangler dev` with its own fresh local D1 and the given settings. */
export async function startInstance(vars: Record<string, string>): Promise<Instance> {
  const state = mkdtempSync(join(tmpdir(), "htmlgate-test-"));
  try {
    execFileSync(WRANGLER, ["d1", "migrations", "apply", "htmlgate-dev", "--local", "--persist-to", state], {
      stdio: "pipe",
      env: { ...process.env, CI: "1" },
    });
    const extra = Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]);
    // --test-scheduled: tests run the hourly cleanup on demand at /__scheduled (local dev only).
    return await wranglerDev(["--test-scheduled", ...extra], state);
  } catch (e) {
    cleanState(state);
    throw e;
  }
}

/** Runs the public landing (site/) under `wrangler dev`. It is not an Instance and has no settings. */
export async function startSite(): Promise<{ base: string; state: string; stop: () => Promise<void> }> {
  const state = mkdtempSync(join(tmpdir(), "htmlgate-site-"));
  try {
    return await wranglerDev(["-c", "site/wrangler.jsonc"], state);
  } catch (e) {
    cleanState(state);
    throw e;
  }
}

async function wranglerDev(extra: string[], state: string): Promise<{ base: string; state: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const args = ["dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(await freePort()),
    "--persist-to", state, "--show-interactive-dev-session=false", "--log-level", "warn", ...extra];
  let log = "";
  // Its own process group, so stop() also ends the workerd children Wrangler starts.
  const worker: ChildProcess = spawn(WRANGLER, args, { env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  worker.stdout!.on("data", (d) => (log += d));
  worker.stderr!.on("data", (d) => (log += d));
  let startError: Error | undefined;
  worker.once("error", (e) => { startError = e; });
  // A run that ends without stop(), such as a timed-out hook, would leave Wrangler and workerd running.
  const reap = () => {
    if (worker.pid === undefined) return;
    try {
      process.kill(-worker.pid!, "SIGKILL");
    } catch {}
  };
  process.once("exit", reap);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      await fetch(`${base}/robots.txt`, { signal: AbortSignal.timeout(1000) });
      break;
    } catch {}
    if (startError || Date.now() > deadline || worker.exitCode !== null) {
      process.off("exit", reap);
      reap();
      throw startError ?? new Error(`wrangler dev did not start:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  // The state is throwaway: left behind, a day of test and mutation runs filled the disk (8,000+ folders, 13 GiB).
  const clean = () => cleanState(state);
  /** Stops the Worker and removes its state; resolves when both are done, so callers await it. */
  const stop = (): Promise<void> => {
    process.off("exit", reap);
    if (worker.exitCode !== null || worker.signalCode !== null) return Promise.resolve(clean());
    const exited = new Promise<void>((r) => worker.once("exit", () => r()));
    // SIGKILL to the whole group: wrangler dev does not always exit on SIGTERM (orphans were found hours later), a
    // later fallback timer dies with the test worker, and a throwaway test Worker needs no graceful shutdown.
    try {
      process.kill(-worker.pid!, "SIGKILL");
    } catch {}
    return exited.then(clean);
  };
  return { base, state, stop };
}

/** A stand-in for the Access team's certs endpoint. */
export async function startCerts() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const pub = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  const priv = { ...(await exportJWK(privateKey)), kid: "test-key", alg: "RS256" };
  const server: Server = createServer((req, res) => {
    if (req.url === "/cdn-cgi/access/certs") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [pub] }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const teamUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { teamUrl, priv, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export const settings = (teamUrl: string, over: Record<string, string> = {}): Record<string, string> => ({
  ACCESS_TEAM_URL: teamUrl,
  ACCESS_AUD: AUD,
  AUTHOR_EMAIL: AUTHOR,
  ALLOWLIST: `${AUTHOR}, ${VIEWER.toUpperCase()}`,
  STORAGE_LIMIT_BYTES: String(STORAGE_LIMIT),
  TICKET_KEY,
  ...over,
});

export default async function setup(project: TestProject) {
  // Every run tests the CLI as the source stands now, mutations included.
  execFileSync(join(process.cwd(), "node_modules/.bin/tsc"), ["-p", "packages/cli"], { stdio: "pipe" });
  const certs = await startCerts();
  const instance = await startInstance(settings(certs.teamUrl)).catch(async (error: unknown) => {
    await certs.close();
    throw error;
  });
  project.provide("base", instance.base);
  project.provide("state", instance.state);
  project.provide("teamUrl", certs.teamUrl);
  project.provide("privateJwk", JSON.stringify(certs.priv));
  return async () => {
    try { await instance.stop(); } finally { await certs.close(); }
    if (process.env.HTMLGATE_MUTATION_TEARDOWN) writeFileSync(process.env.HTMLGATE_MUTATION_TEARDOWN, "complete");
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    base: string;
    /** The shared Instance's local D1 and R2 directory. */
    state: string;
    teamUrl: string;
    privateJwk: string;
  }
}
