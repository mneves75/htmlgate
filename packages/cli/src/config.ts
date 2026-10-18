// Which Instance and token a command uses, and where `login` keeps tokens. Tokens live in one user-level store
// keyed by Instance origin, never in a project, and each goes only to its own origin.
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { CliError } from "./errors.js";

export const TOKEN = /^hg_[A-Za-z0-9]{40}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
// Both files are a few lines. A cloned repository chooses .htmlgate/config, so nothing larger is read.
const MAX_CONFIG_BYTES = 64 * 1024;
const API_URL = /^[ \t]*api_url[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)')[ \t]*(?:#.*)?$/;

export interface Paths {
  projectConfig: string;
  store: string;
}

export function paths(cwd: string, env: NodeJS.ProcessEnv): Paths {
  // XDG: a relative XDG_CONFIG_HOME is invalid and ignored, so credentials never land inside a project.
  const xdg = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(env.HOME || homedir(), ".config");
  return { projectConfig: join(cwd, ".htmlgate", "config"), store: join(xdg, "htmlgate", "credentials") };
}

/** The Instance's origin. https only, except loopback for development; no path, query or credentials. */
export function instanceOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new CliError("invalid_arg", `"${raw}" is not a URL.`, { hint: "Use the Instance's address, such as https://html.example.com." });
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) {
    throw new CliError("insecure_url", `${u.origin} is not https. The CLI sends its token only over https, or to loopback.`);
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) {
    throw new CliError("invalid_arg", `Use the Instance's address alone, without a path: ${u.origin}`);
  }
  return u.origin;
}

export function checkToken(token: string): string {
  if (!TOKEN.test(token)) {
    throw new CliError("invalid_token", "That is not an htmlgate token: it is hg_ followed by 40 letters and digits.", {
      hint: "Copy it again from your Instance's /tokens page.",
    });
  }
  return token;
}

/**
 * A config file's text, or null when there is none. A FIFO, a device or a file over the cap is refused before it is
 * read: O_NONBLOCK keeps a FIFO from hanging the open, and the read stops one byte past the cap.
 */
async function readText(path: string): Promise<string | null> {
  const fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw new CliError("unsafe_path", `Cannot read ${path}: ${e.message}`);
  });
  if (fh === null) return null;
  try {
    if (!(await fh.stat()).isFile()) throw new CliError("unsafe_path", `${path} is not a regular file.`);
    const buf = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let n = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
      if (n > MAX_CONFIG_BYTES) throw new CliError("unsafe_path", `${path} is larger than ${MAX_CONFIG_BYTES} bytes, more than any htmlgate config needs.`);
    }
    return buf.subarray(0, n).toString("utf8");
  } finally {
    await fh.close();
  }
}

/** The first `api_url = "..."` line (or single-quoted, with an optional trailing comment), read one line at a time. */
export function parseApiUrl(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = API_URL.exec(line);
    if (m) return m[1] || m[2] || null;
  }
  return null;
}

/** The project config's api_url, or null when there is no file. */
async function readApiUrl(path: string): Promise<string | null> {
  const text = await readText(path);
  if (text === null) return null;
  const url = parseApiUrl(text);
  if (!url) throw new CliError("invalid_arg", `${path} has no api_url line, or an empty one.`, { hint: 'Write it as: api_url = "https://html.example.com"' });
  return url;
}

type Store = Record<string, string>; // origin -> token

/** The store, or {} when there is none. A damaged store is an error, never treated as empty. */
async function readStore(path: string): Promise<Store> {
  const text = await readText(path);
  if (text === null) return {};
  const damaged = () => new CliError("unsafe_path", `${path} is damaged.`, { hint: "Fix it or delete it, then run `htmlgate login <url>` again." });
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw damaged();
  }
  const instances = (v as { instances?: unknown } | null)?.instances;
  if (typeof instances !== "object" || instances === null || Array.isArray(instances)) throw damaged();
  const out: Store = {};
  for (const [origin, entry] of Object.entries(instances)) {
    const token = (entry as { token?: unknown } | null)?.token;
    if (typeof token !== "string" || !isOrigin(origin)) throw damaged();
    out[origin] = token;
  }
  return out;
}

/** True when `s` is exactly an origin `instanceOrigin` accepts: https, or loopback http, with nothing after it. */
function isOrigin(s: string): boolean {
  try {
    return instanceOrigin(s) === s;
  } catch {
    return false;
  }
}

export interface Resolved {
  api_url: string;
  instanceFrom: "HTMLGATE_URL" | ".htmlgate/config" | "credentials";
}

/** The Instance a command talks to, without looking at any token. */
export async function selectInstance(p: Paths, env: NodeJS.ProcessEnv): Promise<Resolved> {
  const envUrl = env.HTMLGATE_URL?.trim();
  if (envUrl) return { api_url: instanceOrigin(envUrl), instanceFrom: "HTMLGATE_URL" };
  const projectUrl = await readApiUrl(p.projectConfig);
  if (projectUrl) return { api_url: instanceOrigin(projectUrl), instanceFrom: ".htmlgate/config" };
  const origins = Object.keys(await readStore(p.store));
  if (origins.length === 1) return { api_url: origins[0]!, instanceFrom: "credentials" };
  if (origins.length === 0) {
    throw new CliError("auth_required", "No Instance is set.", { hint: "Run `htmlgate login <instance-url>`, or set HTMLGATE_URL and HTMLGATE_TOKEN." });
  }
  throw new CliError("auth_required", `You are signed in to several Instances: ${origins.join(", ")}. Choose one.`, {
    hint: 'Set HTMLGATE_URL, or write api_url = "<url>" in ./.htmlgate/config.',
  });
}

/**
 * The Instance and token for a command. A stored token goes only to its own origin, and $HTMLGATE_TOKEN only to
 * the Instance $HTMLGATE_URL names: a project's files come from whoever wrote the repository.
 */
export async function resolve(p: Paths, env: NodeJS.ProcessEnv): Promise<Resolved & { token: string; tokenFrom: "HTMLGATE_TOKEN" | "credentials" }> {
  const envToken = env.HTMLGATE_TOKEN?.trim();
  if (envToken) {
    if (!env.HTMLGATE_URL?.trim()) {
      throw new CliError("auth_required", "HTMLGATE_TOKEN is set without HTMLGATE_URL. The CLI sends a token from the environment only to the Instance named with it.", {
        hint: "Set HTMLGATE_URL to the Instance the token belongs to.",
      });
    }
    return { ...(await selectInstance(p, env)), token: checkToken(envToken), tokenFrom: "HTMLGATE_TOKEN" };
  }
  const chosen = await selectInstance(p, env);
  const token = (await readStore(p.store))[chosen.api_url];
  if (!token) {
    throw new CliError("auth_required", `Not signed in to ${chosen.api_url}.`, { hint: `Run \`htmlgate login ${chosen.api_url}\`.` });
  }
  return { ...chosen, token: checkToken(token), tokenFrom: "credentials" };
}

/** Refuses a credentials file that is a symlink, so a planted link cannot redirect where a secret is written. */
async function refuseLink(path: string): Promise<void> {
  let st;
  try {
    st = await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new CliError("unsafe_path", `Cannot check ${path}: ${(e as Error).message}`);
  }
  if (st.isSymbolicLink()) throw new CliError("unsafe_path", `${path} is a symbolic link. The CLI does not write credentials through one.`);
}

/** Everything `login` would trip over, checked before it asks the Instance anything. */
export async function checkWritable(p: Paths): Promise<void> {
  const dir = await stat(dirname(p.store)).catch(() => null);
  if (dir && !dir.isDirectory()) throw new CliError("unsafe_path", `${dirname(p.store)} exists and is not a directory.`);
  await refuseLink(p.store);
  await readStore(p.store);
}

/** Runs `fn` while holding the store's lock file, so two logins cannot lose each other's entry. */
async function locked<T>(p: Paths, fn: () => Promise<T>): Promise<T> {
  const dir = dirname(p.store);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700); // the htmlgate directory is ours; tighten one that was created loose
  const lock = `${p.store}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await (await open(lock, "wx", 0o600)).close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > LOCK_STALE_MS) await unlink(lock).catch(() => {});
      else if (Date.now() > deadline) throw new CliError("unsafe_path", `${lock} is held by another htmlgate. If none is running, delete it.`);
      else await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => {});
  }
}

/** Writes the store whole or not at all, with mode 0600 from the moment it exists. */
async function writeStore(path: string, store: Store): Promise<void> {
  await refuseLink(path);
  const instances = Object.fromEntries(Object.entries(store).map(([origin, token]) => [origin, { token }]));
  const tmp = join(dirname(path), `.credentials.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  const fh = await open(tmp, "wx", 0o600);
  try {
    await fh.writeFile(JSON.stringify({ instances }, null, 2) + "\n");
    await fh.sync(); // on disk before the rename, so a crash cannot leave an empty store
    await fh.close();
    await rename(tmp, path);
  } catch (e) {
    await fh.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

async function update(p: Paths, change: (s: Store) => boolean): Promise<boolean> {
  try {
    return await locked(p, async () => {
      const store = await readStore(p.store);
      const changed = change(store);
      if (changed) await writeStore(p.store, store);
      return changed;
    });
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError("unsafe_path", `Could not update ${p.store}: ${(e as Error).message}`);
  }
}

export async function save(p: Paths, origin: string, token: string): Promise<void> {
  await update(p, (s) => {
    s[origin] = token;
    return true;
  });
}

/** Removes one Instance's token; true when there was one. */
export async function forget(p: Paths, origin: string): Promise<boolean> {
  if ((await readText(p.store)) === null) return false;
  return update(p, (s) => {
    if (!(origin in s)) return false;
    delete s[origin];
    return true;
  });
}
