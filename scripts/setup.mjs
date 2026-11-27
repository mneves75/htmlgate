#!/usr/bin/env node
// Sets up or updates an Instance on the Operator's own Cloudflare account. Safe to run again.
// Needs Wrangler and Cloudflare's `cf` CLI, both logged in to that account.
// Order (issue #18): domain check, database, migrations, deploy with workers.dev off, Access
// application, deploy with the custom domain on (or workers.dev, without one). The Worker is never reachable before its gate exists, and it
// refuses every gated request on its own if the gate is ever removed.
//
// Usage: pnpm run setup [--config instance.json] [--rotate-ticket-key]
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = join(ROOT, "node_modules/.bin/wrangler");
const PUBLIC_PATHS = ["/api/*", "/p/*", "/f/*"];
export const CRONS = ["17 * * * *"];

export const generatedConfig = (inst) => join(ROOT, ".instance", `${inst.name}.wrangler.jsonc`);

export function readInstance(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`Cannot read ${path}: ${e.message}. Copy instance.example.json to instance.json and fill it in.`);
  }
  const email = /^[^\s@,]+@[^\s@,]+$/;
  if (typeof raw.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,52}$/.test(raw.name)) {
    throw new Error("name must be 1 to 53 lowercase letters, digits or '-', starting with a letter or digit.");
  }
  if (raw.name === "htmlgate-site" || raw.name === "htmlgate-site-preview") {
    throw new Error(`name ${raw.name} belongs to the htmlgate landing's Worker. Pick another name.`);
  }
  if (typeof raw.authorEmail !== "string" || !email.test(raw.authorEmail)) throw new Error("authorEmail must be an email address.");
  if (!Array.isArray(raw.allowlist) || !raw.allowlist.every((e) => typeof e === "string" && email.test(e))) {
    throw new Error("allowlist must be a list of email addresses (it may be empty; the Author is always allowed).");
  }
  const hostname = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  const domain = typeof raw.domain === "string" ? raw.domain.trim().toLowerCase() : raw.domain;
  if (domain !== undefined && (typeof domain !== "string" || !hostname.test(domain) || domain.length > 253)) {
    throw new Error("domain must be a hostname such as html.example.com, without https:// or a path.");
  }
  const language = raw.language === undefined ? "en" : raw.language;
  if (language !== "en" && language !== "pt-BR") throw new Error('language must be "en" or "pt-BR" (default "en").');
  const expiryDays = raw.expiryDays === undefined ? 30 : raw.expiryDays;
  if (!Number.isSafeInteger(expiryDays) || expiryDays < 0 || expiryDays > 3650) {
    throw new Error("expiryDays must be a whole number of days from 0 (never) to 3650.");
  }
  const mfa = raw.mfa === undefined ? false : raw.mfa;
  if (typeof mfa !== "boolean") throw new Error("mfa must be true or false (default false).");
  const staging = raw.staging === undefined ? false : raw.staging;
  if (typeof staging !== "boolean") throw new Error("staging must be true or false (default false).");
  // ASCII letters only: the fold the Worker applies to a sign-in's email (src/access.ts).
  // A non-ASCII capital is refused: 0.1.24 stored its rows under the Unicode lowercase, which this fold no longer reaches.
  const fold = (e) => {
    const folded = e.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (folded !== folded.toLowerCase()) throw new Error(`Write ${e.trim()} in lowercase: htmlgate lowercases only A to Z in an email.`);
    return folded;
  };
  const author = fold(raw.authorEmail);
  const allowlist = [...new Set([author, ...raw.allowlist.map(fold)])];
  return { name: raw.name, author, allowlist, domain, language, expiryDays, mfa, staging, ...(raw.bootstrapStorage === undefined ? {} : { bootstrapStorage: raw.bootstrapStorage }) };
}

export const instanceVars = (inst, teamUrl, aud) => ({
  ACCESS_TEAM_URL: teamUrl, ACCESS_AUD: aud, AUTHOR_EMAIL: inst.author, ALLOWLIST: inst.allowlist.join(","), LANGUAGE: inst.language,
  EXPIRY_DAYS: String(inst.expiryDays),
});

export function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" }, ...opts });
  } catch (e) {
    throw new Error(`${cmd} ${args.slice(0, 4).join(" ")} failed:\n${(e.stderr || e.stdout || e.message).toString().slice(0, 2000)}`);
  }
}

export const cf = (...args) => JSON.parse(sh("cf", args));

const DEPLOYED = ["src", "site", "migrations", "packages/cli/src", "scripts", "package.json", "pnpm-lock.yaml", "tsconfig.json"];
const gitStatus = () => {
  const root = sh("git", ["rev-parse", "--show-toplevel"]).trim();
  if (realpathSync(root) !== realpathSync(ROOT)) {
    throw new Error("Git checkout root does not match this project. Use a Git clone or registered worktree rooted at the project directory.");
  }
  return sh("git", ["status", "--porcelain", "--untracked-files=all", "--", ...DEPLOYED]);
};

export function checkCleanTree(status = gitStatus) {
  const dirty = status().trim();
  if (dirty) throw new Error(`These files have uncommitted changes. Commit or restore them, then deploy:\n${dirty}`);
}

/** Who Wrangler is logged in as. Logged out, `whoami --json` still prints its JSON but exits 1, so read stdout either way. */
export function wranglerWho(env = process.env) {
  let out;
  try {
    out = execFileSync(WRANGLER, ["whoami", "--json"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...env, CI: "1" } });
  } catch (e) {
    out = String(e.stdout ?? "");
  }
  try {
    return JSON.parse(out);
  } catch {
    throw new Error("Wrangler could not say which account it is logged in to. Run `pnpm exec wrangler whoami` to see why.");
  }
}

export function checkSameAccount(wranglerWho, cfWho, env) {
  if (!wranglerWho?.loggedIn) throw new Error("Wrangler is not logged in. Run `pnpm exec wrangler login`.");
  if (!cfWho?.tokenValid) throw new Error("cf is not logged in. Run `cf auth login`.");
  const w = Array.isArray(wranglerWho.accounts) ? wranglerWho.accounts : [];
  const c = Array.isArray(cfWho.accounts) ? cfWho.accounts : [];
  let mine;
  if (env.CLOUDFLARE_ACCOUNT_ID) {
    mine = w.find((a) => a.id === env.CLOUDFLARE_ACCOUNT_ID);
    if (!mine && !w.length) throw new Error("Wrangler's login lists no accounts, so setup cannot check CLOUDFLARE_ACCOUNT_ID. Give its API token Account Settings: Read.");
    if (!mine) throw new Error("CLOUDFLARE_ACCOUNT_ID names an account Wrangler's login cannot reach.");
  } else if (w.length === 1) {
    mine = w[0];
  } else {
    throw new Error(w.length ? "Wrangler's login reaches several accounts. Set CLOUDFLARE_ACCOUNT_ID to the one for this Instance." : "Wrangler's login reaches no account.");
  }
  if (c.length !== 1) {
    throw new Error(c.length
      ? "cf's login reaches several accounts, and setup cannot tell which one cf would act on. Use a cf login or token scoped to one account (`cf auth create`, then `cf auth activate`)."
      : "cf's login reaches no account.");
  }
  if (c[0].id !== mine.id) throw new Error(`Wrangler would use the account "${mine.name}" and cf the account "${c[0].name}". Log both in to the same account.`);
  if (typeof mine.id !== "string" || !mine.id) throw new Error("The tools did not identify the shared Cloudflare account.");
  return mine.id;
}

export const bodiesBucket = (inst) => `${inst.name}-bodies`;

// `open: false` deploys a Worker that answers at no hostname; only the gated deploy opens it, at the domain if there is
// one and otherwise at workers.dev. With a domain, workers.dev stays off: it has no WAF and no Always Use HTTPS.
export function workerConfig(inst, db, { open, vars, accountId }) {
  return {
    name: inst.name,
    ...(accountId === undefined ? {} : { account_id: accountId }),
    main: "../src/index.ts",
    compatibility_date: "2026-09-29",
    workers_dev: open && !inst.domain,
    ...(open && inst.domain ? { routes: [{ pattern: inst.domain, custom_domain: true }] } : {}),
    preview_urls: false,
    d1_databases: [{ binding: "DB", database_name: db.name, database_id: db.uuid, migrations_dir: "../migrations" }],
    r2_buckets: [{ binding: "BODIES", bucket_name: bodiesBucket(inst) }],
    ratelimits: [
      { name: "WRITE_LIMIT", namespace_id: "1001", simple: { limit: 60, period: 60 } },
      { name: "VIEW_LIMIT", namespace_id: "1002", simple: { limit: 1, period: 60 } },
    ],
    triggers: { crons: inst.staging ? [] : CRONS },
    rules: [{ type: "Data", globs: ["**/media/*.jpg"], fallthrough: true }],
    observability: { enabled: true, logs: { enabled: true, invocation_logs: false }, traces: { enabled: false } },
    vars: { ...vars, HTMLGATE_INSTANCE: inst.name },
  };
}

export function deploymentUrls(inst, output) {
  const dev = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(output)?.[0];
  if (inst.domain) {
    if (dev) throw new Error(`Deployed, but Wrangler printed ${dev}: workers.dev is still on. Turn it off in the dashboard (Workers, ${inst.name}, Settings, Domains & Routes) and run setup again.`);
    return [`https://${inst.domain}`];
  }
  if (!dev) throw new Error("Deployed, but Wrangler printed no workers.dev URL.");
  return [dev];
}

export function ensureInstanceDir(dir) {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${dir} must be a real directory, not a symbolic link.`);
  } else {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  chmodSync(dir, 0o700);
}

export function writeConfig(inst, db, opts) {
  const file = generatedConfig(inst);
  ensureInstanceDir(dirname(file));
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error(`${file} is a symbolic link; refusing to overwrite it.`);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, "// Generated by scripts/setup.mjs. Do not edit; do not commit.\n" + JSON.stringify(workerConfig(inst, db, opts), null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true });
    renameSync(temp, file);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
}

// cf pages silently, so read every page until an empty one. The cap stops a CLI that ignores --page.
export function listWorkers(cf) {
  const all = [];
  for (let page = 1; page <= 1000; page++) {
    const batch = cf("workers", "list", "--per-page", "100", "--page", String(page));
    if (!Array.isArray(batch)) throw new Error("cf returned no Worker list.");
    if (batch.length === 0) return all;
    all.push(...batch);
  }
  throw new Error("cf kept returning Workers past page 1000.");
}

// Access lists page silently too. A partial list cannot prove that a name or destination is free.
export function listApplications(cfImpl = cf) {
  const all = [];
  for (let page = 1; page <= 1000; page++) {
    const batch = cfImpl("zero-trust", "access", "applications", "list", "--per-page", "1000", "--page", String(page));
    if (!Array.isArray(batch)) throw new Error("cf returned no Access application list.");
    if (!batch.length) return all;
    all.push(...batch);
  }
  throw new Error("cf kept returning Access applications past page 1000.");
}

// cf omits the cursor, so advance by name and require an empty terminal page.
function listBuckets() {
  const all = [];
  let after = "";
  for (let page = 1; page <= 1000; page++) {
    const buckets = cf("r2", "buckets", "list", "--per-page", "1000", "--order", "name", "--direction", "asc", ...(after ? ["--start-after", after] : []))?.buckets;
    if (!Array.isArray(buckets) || buckets.some((b) => !b || typeof b.name !== "string")) throw new Error("Malformed R2 bucket list.");
    if (!buckets.length) return all;
    for (const bucket of buckets) {
      if (bucket.name <= after) throw new Error("R2 bucket names are ambiguous or not advancing.");
      after = bucket.name;
    }
    all.push(...buckets);
  }
  throw new Error("cf kept returning R2 buckets past page 1000.");
}

export function checkOwnership(inst, db, workers, apps, { requireAppAudience = false } = {}) {
  const named = (items, name, what) => {
    if (items.some((item) => !item || typeof item.name !== "string" || !item.name || typeof item.id !== "string" || !item.id)
      || new Set(items.map((item) => item.id)).size !== items.length) throw new Error(`Malformed or ambiguous ${what} list; cannot establish Instance ownership.`);
    const matches = items.filter((item) => item.name === name);
    if (matches.length > 1) throw new Error(`Ambiguous ${what} ownership for ${inst.name}.`);
    return matches[0];
  };
  const worker = named(workers, inst.name, "Worker");
  const app = named(apps, `htmlgate: ${inst.name}`, "Access application");
  const validDestinations = apps.every((a) => !Object.hasOwn(a, "destinations") || (Array.isArray(a.destinations) && a.destinations.every((d) => {
    if (!d || typeof d !== "object" || Array.isArray(d)) return false;
    if (d.type === "worker" || d.type === "preview_worker") return typeof d.worker_id === "string" && d.worker_id.trim().length > 0;
    if (Object.hasOwn(d, "worker_id")) return false;
    if (d.type === undefined || d.type === "public") return d.uri === undefined || typeof d.uri === "string";
    return ["private", "via_mcp_server_portal", "all_workers", "all_preview_workers"].includes(d.type);
  })));
  if (!validDestinations) throw new Error("Malformed Access destinations; cannot establish Instance ownership.");
  if (!worker) {
    if (app) throw new Error("An Access application exists without its Worker; cannot establish Instance ownership.");
    return { worker, app };
  }
  if (requireAppAudience && (typeof app?.aud !== "string" || !app.aud)) throw new Error("Missing Access application audience; cannot establish Instance ownership.");
  if (!db?.uuid) throw new Error(`Worker ${inst.name} exists without this Instance's database; pick another name.`);
  // Exact Worker destinations override account-wide policies; preview-only destinations have their own scope.
  const attached = apps.filter((a) => Array.isArray(a.destinations) && a.destinations.some((d) => d?.type === "worker" && d.worker_id === worker.id));
  if (app) {
    if (app.type !== "self_hosted" || !Array.isArray(app.destinations) || app.destinations.length !== 1
      || app.destinations[0]?.type !== "worker" || app.destinations[0].worker_id !== worker.id
      || attached.length !== 1 || attached[0].id !== app.id) throw new Error("Access application does not uniquely belong to this Instance's Worker.");
  } else if (attached.length) throw new Error("Another Access application owns this Worker.");

  const active = cf("workers", "deployments", "list", "--worker", inst.name, "--page", "1", "--per-page", "1");
  const versions = active?.deployments?.[0]?.versions;
  if (!Array.isArray(active?.deployments) || active.deployments.length !== 1 || !Array.isArray(versions) || !versions.length
    || versions.some((v) => !v || typeof v.version_id !== "string" || !v.version_id || typeof v.percentage !== "number" || !Number.isFinite(v.percentage) || v.percentage < 0 || v.percentage > 100)
    || new Set(versions.map((v) => v.version_id)).size !== versions.length
    || Math.abs(versions.reduce((total, v) => total + v.percentage, 0) - 100) > 0.000001) throw new Error("Missing or malformed active deployment; cannot establish Instance ownership.");
  for (const version of versions.filter((v) => v.percentage > 0)) {
    const detail = JSON.parse(sh(WRANGLER, ["versions", "view", version.version_id, "--name", inst.name, "--json"]));
    const bindings = detail?.resources?.bindings;
    if (!Array.isArray(bindings) || bindings.some((b) => !b || typeof b.name !== "string" || typeof b.type !== "string")) throw new Error("Missing or malformed active Worker bindings.");
    const one = (name) => {
      const matches = bindings.filter((b) => b.name === name);
      return matches.length === 1 ? matches[0] : undefined;
    };
    const database = one("DB");
    const bodies = one("BODIES");
    if (database?.type !== "d1" || database.id !== db.uuid || bodies?.type !== "r2_bucket" || bodies.bucket_name !== bodiesBucket(inst) || !isDefaultBucketJurisdiction(bodies.jurisdiction)) throw new Error("Active Worker bindings do not belong to this Instance.");
    if (!app) {
      const marker = one("HTMLGATE_INSTANCE");
      if (marker?.type !== "plain_text" || marker.text !== inst.name
        || bindings.some((b) => ["ACCESS_TEAM_URL", "ACCESS_AUD", "AUTHOR_EMAIL", "ALLOWLIST"].includes(b.name))) throw new Error("Worker is not a marked closed htmlgate bootstrap; cannot establish Instance ownership.");
    }
    if (requireAppAudience) {
      const audience = one("ACCESS_AUD");
      if (audience?.type !== "plain_text" || audience.text !== app.aud) throw new Error("Active Worker audience does not match its Access application.");
    }
  }
  return { worker, app };
}

const databaseName = (inst) => `${inst.name}-db`;
const isDatabaseId = (id) => typeof id === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id);

export function findDatabase(inst) {
  const list = JSON.parse(sh(WRANGLER, ["d1", "list", "--json"]));
  if (!Array.isArray(list) || list.some((d) => !d || typeof d.name !== "string" || !isDatabaseId(d.uuid))) throw new Error("Malformed database list.");
  const matches = list.filter((d) => d.name === databaseName(inst));
  if (matches.length > 1) throw new Error("Ambiguous Instance database name.");
  return matches[0];
}

export const isDefaultBucketJurisdiction = (jurisdiction) => jurisdiction === undefined || jurisdiction === "default";
const bucketIdentity = (bucket) => ({ createdAt: bucket?.creation_date, jurisdiction: bucket?.jurisdiction === undefined ? "default" : bucket.jurisdiction });
const validBucketIdentity = (bucket) => typeof bucket?.createdAt === "string" && Number.isFinite(Date.parse(bucket.createdAt))
  && bucket.jurisdiction === "default";
const sameBucket = (a, b) => a.createdAt === b.createdAt && a.jurisdiction === b.jurisdiction;

function checkBucketPrivacy(bucket) {
  const managed = cf("r2", "buckets", "domains", "managed", "get", bucket);
  const custom = cf("r2", "buckets", "domains", "custom", "list", "--bucket-name", bucket);
  if (managed?.enabled !== false || !Array.isArray(custom?.domains) || custom.domains.some((d) => !d || d.enabled !== false)) throw new Error("The reused R2 bucket is public or its privacy is unknown. Disable every public domain before setup.");
}

function checkStorageProof(proof, accountId, db, bucket, source) {
  if (!proof || proof.accountId !== accountId || !(Object.hasOwn(proof, "databaseId") || Object.hasOwn(proof, "bucket"))) {
    throw new Error(`Invalid bootstrap storage ${source} for this account.`);
  }
  if (Object.hasOwn(proof, "databaseId") && (!isDatabaseId(proof.databaseId) || proof.databaseId !== db?.uuid)) {
    throw new Error(`The database does not match the bootstrap storage ${source}.`);
  }
  if (Object.hasOwn(proof, "bucket") && (!validBucketIdentity(proof.bucket) || !sameBucket(proof.bucket, bucketIdentity(bucket)))) {
    throw new Error(`The R2 bucket does not match the bootstrap storage ${source}.`);
  }
}

function readBootstrapReceipt(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077)) throw new Error("expected a private regular file (0600)");
    return JSON.parse(readFileSync(fd, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`Cannot read bootstrap storage receipt: ${e.message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeBootstrapReceipt(file, proof) {
  const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(proof, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true });
    renameSync(temp, file);
    const dir = openSync(dirname(file), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch (e) {
    rmSync(temp, { force: true });
    throw new Error(`Cannot save bootstrap storage receipt: ${e.message}. Before retrying, verify which resources were created and pin their identities in bootstrapStorage.`);
  }
}

function createStorageResource(name, ...args) {
  const out = sh("cf", [...args, "--name", name]);
  let resource;
  try { resource = JSON.parse(out); } catch {}
  if (resource?.name !== name) {
    throw new Error(`Cloudflare did not identify the created resource ${name}. Check the account and pin its identity in bootstrapStorage before retrying.`);
  }
  return resource;
}

// Wrangler runs here without a terminal, so it would replace an existing DNS record or move another
// Worker's Custom Domain without asking. This refuses any domain the Instance does not already own,
// before setup writes anything. `cf` is injected so the tests can stand in for the CLI.
// A Custom Domain's records are address records pointing at its Worker, so only an address record on the
// hostname can be replaced by it or stand in its way; mail records (MX, TXT, such as Email Routing's) stay beside it.
const ADDRESS_TYPES = new Set(["A", "AAAA", "CNAME"]);

export function checkDomain(inst, cf) {
  const { domain } = inst;
  if (!domain) return;
  const list = (what, ...args) => {
    const out = cf(...args);
    if (!Array.isArray(out)) throw new Error(`cf returned no ${what} list; cannot check domain ${domain}.`);
    return out;
  };
  const labels = domain.split(".");
  let zone;
  for (let i = 0; i < labels.length - 1 && !zone; i++) {
    const name = labels.slice(i).join(".");
    zone = list("zone", "zones", "list", "--name", name).find((z) => z.name === name && z.status === "active");
  }
  if (!zone) throw new Error(`domain ${domain}: no active zone on this Cloudflare account covers it. Add the zone first.`);

  // A Worker's Custom Domain ids are the `origin_worker_id` of the DNS records it manages.
  const workers = listWorkers(cf);
  const customDomains = (w) => (w.references?.domains ?? []).filter((d) => d.hostname === domain);
  const other = workers.find((w) => w.name !== inst.name && customDomains(w).length > 0);
  if (other) throw new Error(`domain ${domain} is a Custom Domain of the Worker ${other.name}. Setup will not move it.`);
  const ourDomainIds = new Set(workers.filter((w) => w.name === inst.name).flatMap(customDomains).map((d) => d.id).filter((id) => typeof id === "string" && id.length > 0));

  const records = [];
  for (let page = 1; ; page++) {
    if (page > 1000) throw new Error("cf kept returning DNS records past page 1000.");
    const batch = list("DNS record", "dns", "records", "list", "-z", zone.id, "--name", domain, "--per-page", "100", ...(page > 1 ? ["--page", String(page)] : []));
    if (batch.length === 0) break;
    records.push(...batch);
    if (batch.length < 100) break;
  }
  const foreign = records.find((r) => ADDRESS_TYPES.has(r.type) && !ourDomainIds.has(r.meta?.origin_worker_id));
  if (foreign) throw new Error(`domain ${domain} has a ${foreign.type} record that setup would replace. Remove it or pick another hostname.`);
}

export function isGateRedirect(status, location, { teamUrl, aud, host }) {
  if (status !== 302 || !location || !URL.canParse(location)) return false;
  const to = new URL(location);
  if (to.origin !== teamUrl) return false;
  if (to.searchParams.get("kid") !== aud) return false;
  return to.pathname === `/cdn-cgi/access/login/${host}`;
}

// Polls because a freshly enabled workers.dev route answers 404 for a few seconds (issue #18), and a
// new custom domain needs its DNS record and certificate first. Every request ends by the deadline,
// so one hostname never takes longer than its budget plus one pause.
export async function gated(url, gate, { budgetMs = 180_000, pauseMs = 2000 } = {}) {
  const until = Date.now() + budgetMs;
  let home, api, files, ok = false;
  const done = () => ok && api.status === 401 && files.status === 404;
  for (let i = 0; !done(); i++) {
    if (i) await new Promise((r) => setTimeout(r, pauseMs));
    const left = until - Date.now();
    if (left <= 0) break;
    try {
      const signal = AbortSignal.timeout(Math.min(10_000, left));
      home = await fetch(url + "/", { redirect: "manual", signal });
      api = await fetch(url + "/api/shares", { redirect: "manual", signal });
      files = await fetch(url + "/f/" + "A".repeat(64) + "/", { redirect: "manual", signal });
    } catch {
      ok = false;
      continue;
    }
    ok = isGateRedirect(home.status, home.headers.get("location"), { ...gate, host: new URL(url).host });
  }
  console.log(`  ${url}: ${done() ? "ok" : "NOT GATED"}: / answers ${home?.status ?? "nothing"}; /api/shares answers ${api?.status ?? "nothing"} (401 expected); /f/ answers ${files?.status ?? "nothing"} (404 expected)`);
  return done();
}

// Second factors Access can ask for in a browser; piv_key and ssh_fido2_key apply only to SSH applications.
const WEB_MFA = ["totp", "biometrics", "security_key"];

export function accessApp(inst, workerId, orgMfa = []) {
  const methods = orgMfa.filter((m) => WEB_MFA.includes(m));
  if (inst.mfa && !methods.length) {
    throw new Error("mfa is on, but the Zero Trust organization allows no second factor for web sign-in. In the dashboard: Zero Trust, Access controls, Access settings, Allow multi-factor authentication: choose Biometrics, Security key or Authenticator application, save, enrol yours at https://<team>.cloudflareaccess.com/AddMfaDevice, then run setup again.");
  }
  return {
    type: "self_hosted",
    name: `htmlgate: ${inst.name}`,
    session_duration: "24h",
    // Cloudflare's default is SameSite=None: another site could make a signed-in browser send the cookie. Lax still
    // goes with a top-level link to a Share. The token page's Fetch Metadata check stays the deciding defence.
    same_site_cookie_attribute: "lax",
    http_only_cookie_attribute: true,
    app_launcher_visible: false,
    destinations: [{ type: "worker", worker_id: workerId, overrides: PUBLIC_PATHS.map((p) => ({ behavior: "public", path_pattern: p })) }],
    policies: [{ name: `htmlgate: ${inst.name} allowlist`, decision: "allow", include: inst.allowlist.map((email) => ({ email: { email } })) }],
    ...(inst.mfa ? { mfa_config: { mfa_disabled: false, allowed_authenticators: methods, session_duration: "24h" } } : {}),
  };
}

/**
 * The second Access application an Instance needs: one path, `robots.txt`, open to everyone. A crawler reads robots.txt
 * before it reads anything else, so a gated one is a policy no crawler can follow - X in particular refuses to build a
 * card for a site whose robots.txt it cannot read, which is why a Public Share previewed on WhatsApp and not on X. The
 * path is a separate application because a public override on the gate application only matches `<segment>/*` paths:
 * `/og.jpg` and `/robots.txt` were persisted there and never took effect.
 */
export function robotsApp(inst, host) {
  return {
    type: "self_hosted",
    name: `htmlgate: ${inst.name} robots`,
    domain: `${host}/robots.txt`,
    session_duration: "24h",
    app_launcher_visible: false,
    policies: [{ name: `htmlgate: ${inst.name} robots bypass`, decision: "bypass", include: [{ everyone: {} }] }],
  };
}

export const r2NotEnabled = (message) => /\b10042\b|enable R2/i.test(message);

function ensureTicketKey(config, rotate) {
  const names = JSON.parse(sh(WRANGLER, ["secret", "list", "-c", config, "--format", "json"])).map((s) => s.name);
  if (names.includes("TICKET_KEY") && !rotate) return "kept";
  putTicketKey(config);
  return names.includes("TICKET_KEY") ? "replaced" : "created";
}

export function putTicketKey(config) {
  const out = execFileSync(WRANGLER, ["secret", "put", "TICKET_KEY", "-c", config], {
    cwd: ROOT, input: randomBytes(32).toString("base64url"), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CI: "1" },
  });
  if (!out.includes("Success! Uploaded secret TICKET_KEY")) throw new Error("Wrangler did not confirm that it uploaded the ticket key.");
}

export function parseSetupArgs(argv) {
  let config = "instance.json";
  let rotateTicketKey = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) throw new Error("--config requires a path.");
      config = value;
    } else if (a === "--rotate-ticket-key") {
      rotateTicketKey = true;
    } else {
      throw new Error(`Unknown argument "${a}". Usage: pnpm run setup [--config instance.json] [--rotate-ticket-key]`);
    }
  }
  return { config, rotateTicketKey };
}

const AUTH_DOMAIN_HOST = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function verifyAccessApp(app, inst, workerId) {
  if (typeof app?.aud !== "string" || !app.aud.trim()) throw new Error("The Access application has no audience tag.");
  if (app.same_site_cookie_attribute !== "lax" || app.http_only_cookie_attribute !== true) {
    throw new Error("Cloudflare returned an Access application without SameSite=Lax and HttpOnly cookies.");
  }
  if (!Array.isArray(app.destinations) || app.destinations.length !== 1 || app.destinations[0]?.type !== "worker" || app.destinations[0].worker_id !== workerId) {
    throw new Error("Cloudflare returned an Access application whose Worker destination does not match this Instance.");
  }
  if (inst.mfa && app.mfa_config?.mfa_disabled !== false) {
    throw new Error("mfa is enabled in the Instance config, but Cloudflare did not enable MFA on the Access application.");
  }
}

async function main() {
  const { config: configArg, rotateTicketKey } = parseSetupArgs(process.argv.slice(2));
  const inst = readInstance(resolve(ROOT, configArg));
  const step = (s) => console.log(`- ${s}`);

  step("checking that the source is committed");
  checkCleanTree();
  step("checking the Cloudflare logins");
  const accountId = checkSameAccount(wranglerWho(), cf("auth", "whoami"), process.env);

  const orgs = cf("zero-trust", "organization", "get");
  const org = Array.isArray(orgs) ? orgs[0] : orgs;
  const authDomain = typeof org?.auth_domain === "string" ? org.auth_domain.trim().toLowerCase() : "";
  if (!authDomain) throw new Error("This account has no Zero Trust organization. Create one in the dashboard (Zero Trust), then run setup again.");
  if (!AUTH_DOMAIN_HOST.test(authDomain) || authDomain.length > 253) {
    throw new Error(`Zero Trust organization auth_domain "${authDomain}" is not a valid hostname.`);
  }
  const teamUrl = `https://${authDomain}`;

  if (inst.domain) {
    step(`checking that ${inst.domain} is free or already this Instance's`);
    checkDomain(inst, cf);
  }

  step("finding or creating the database");
  const dbName = databaseName(inst);
  let db = findDatabase(inst);
  const freshDb = !db;
  step("checking existing Instance ownership before any remote write");
  const owned = checkOwnership(inst, db, listWorkers(cf), listApplications());

  step("finding or creating the R2 bucket");
  const bucket = bodiesBucket(inst);
  try {
    const buckets = listBuckets();
    const existingBucket = buckets.find((b) => b.name === bucket);
    if (existingBucket) checkBucketPrivacy(bucket);
    if (owned.worker && !existingBucket) throw new Error("The Instance's active Worker has no R2 bucket; check its storage before setup.");

    const instanceDir = dirname(generatedConfig(inst));
    ensureInstanceDir(instanceDir);
    const receiptFile = join(instanceDir, `${inst.name}.bootstrap.json`);
    const receipt = readBootstrapReceipt(receiptFile);
    if (receipt !== undefined) checkStorageProof(receipt, accountId, db, existingBucket, "receipt");
    if (!owned.worker) {
      const adoption = inst.bootstrapStorage;
      if (adoption !== undefined) checkStorageProof(adoption, accountId, db, existingBucket, "adoption");
      const proof = { accountId, databaseId: adoption?.databaseId ?? receipt?.databaseId, bucket: adoption?.bucket ?? receipt?.bucket };
      if ((db && !proof.databaseId) || (existingBucket && !proof.bucket)) {
        throw new Error("Cannot establish bootstrap storage ownership from a name alone. Pick another Instance name or verify and pin the existing resources in bootstrapStorage.");
      }
      mkdirSync(dirname(receiptFile), { recursive: true, mode: 0o700 });
      if (adoption !== undefined) writeBootstrapReceipt(receiptFile, proof);
      if (freshDb) {
        db = createStorageResource(dbName, "d1", "create");
        if (!isDatabaseId(db.uuid)) throw new Error("Cloudflare did not return the created database ID. Verify it and pin it in bootstrapStorage before retrying.");
        proof.databaseId = db.uuid;
        writeBootstrapReceipt(receiptFile, proof);
      }
      if (!existingBucket) {
        const created = bucketIdentity(createStorageResource(bucket, "r2", "buckets", "create"));
        if (!validBucketIdentity(created)) throw new Error("Cloudflare did not return the created R2 bucket identity. Verify it and pin it in bootstrapStorage before retrying.");
        proof.bucket = created;
        writeBootstrapReceipt(receiptFile, proof);
        checkBucketPrivacy(bucket);
      }
    }
  } catch (e) {
    if (!r2NotEnabled(e.message)) throw e;
    throw new Error("R2 is not enabled on this account. In the Cloudflare dashboard open Storage & databases, R2, Overview, and "
      + "complete the checkout to add the R2 subscription (it includes a free monthly allowance), then run setup again.");
  }

  step("applying migrations");
  const config = generatedConfig(inst);
  const existingAudience = owned.app?.aud;
  writeConfig(inst, db, { open: Boolean(existingAudience), vars: existingAudience ? instanceVars(inst, teamUrl, existingAudience) : {}, accountId });
  sh(WRANGLER, ["d1", "migrations", "apply", dbName, "--remote", "-c", config]);

  const findWorker = () => listWorkers(cf).find((w) => w.name === inst.name);
  const existing = owned.app;
  let worker = owned.worker;
  if (!existing || !worker) {
    step("first deploy, with workers.dev off");
    sh(WRANGLER, ["deploy", "-c", config]);
    worker = findWorker();
  }
  if (!worker?.id) throw new Error(`Could not find the Worker ${inst.name} after deploying it.`);

  step("checking the ticket key");
  console.log(`  ${ensureTicketKey(config, rotateTicketKey)}`);

  step(existing ? "updating the Access application" : "creating the Access application");
  const body = JSON.stringify(accessApp(inst, worker.id, org.mfa_config?.allowed_authenticators ?? []));
  let app = existing
    ? cf("zero-trust", "access", "applications", "update", existing.id, "--body", body)
    : cf("zero-trust", "access", "applications", "create", "--body", body);
  if (app?.id && (typeof app.aud !== "string" || !app.aud.trim() || !Object.hasOwn(app, "same_site_cookie_attribute") || !Object.hasOwn(app, "http_only_cookie_attribute") || !Object.hasOwn(app, "destinations") || (inst.mfa && !Object.hasOwn(app, "mfa_config")))) {
    app = cf("zero-trust", "access", "applications", "get", app.id);
  }
  verifyAccessApp(app, inst, worker.id);
  if (inst.mfa && existing && existing.mfa_config?.mfa_disabled !== false) {
    console.log("  note: MFA is now enabled; run `pnpm run token revoke-all` or revoke Access sessions in Zero Trust if existing 24h sessions should re-authenticate immediately.");
  }
  if (!inst.mfa && app.mfa_config?.mfa_disabled === false) {
    console.log("  note: MFA remains enabled on the existing Access application (set mfa: true in your Instance config to track it, or disable MFA in Zero Trust).");
  }

  step(inst.domain ? `deploying with ${inst.domain} on and workers.dev off` : "deploying with workers.dev on");
  writeConfig(inst, db, {
    open: true,
    vars: instanceVars(inst, teamUrl, app.aud),
    accountId,
  });
  const urls = deploymentUrls(inst, sh(WRANGLER, ["deploy", "-c", config]));

  step("opening robots.txt to crawlers");
  const host = new URL(urls[0]).host;
  const robotsName = `htmlgate: ${inst.name} robots`;
  const robotsWanted = `${host}/robots.txt`;
  const apps = listApplications();
  const byName = apps.filter((a) => a?.name === robotsName);
  if (byName.length > 1) throw new Error(`Ambiguous ownership for ${robotsName}; more than one application has that name.`);
  const byPath = apps.filter((a) => a?.domain === robotsWanted);
  if (byPath.length > 1) throw new Error(`Ambiguous ownership for ${robotsWanted}; more than one application answers it.`);
  if (byPath.length && byName.length && byPath[0].id !== byName[0].id) {
    throw new Error(`${robotsName} answers ${byName[0].domain} while another application answers ${robotsWanted}; refusing to guess.`);
  }
  if (byPath.length && !byName.length) {
    throw new Error(`${robotsWanted} is already answered by the application "${byPath[0].name}", which setup does not own. Remove it, or rename it ${robotsName}.`);
  }
  if (byName.length && byName[0].domain !== robotsWanted) {
    throw new Error(`${robotsName} answers ${byName[0].domain}, not ${robotsWanted}; refusing to repoint another application.`);
  }
  cf("zero-trust", "access", "applications", byName.length ? "update" : "create", ...(byName.length ? [byName[0].id] : []),
    "--body", JSON.stringify(robotsApp(inst, host)));
  console.log(`  ${robotsWanted} answers without a session`);

  step("checking the gate");
  const results = [];
  for (const u of urls) results.push(await gated(u, { teamUrl, aud: app.aud }));
  if (results.includes(false)) {
    throw new Error("The Instance is not behind its gate yet. Access, DNS and certificates can take a while; run setup again. It refuses gated requests on its own meanwhile.");
  }
  console.log(`\nInstance ready: ${urls.at(-1)}\nNext: pnpm run token create <name> for your first Publisher.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`setup failed: ${e.message}`);
    process.exit(1);
  });
}
