// Run the public setup command. Only provider processes/transports are controlled; the decision and config writes are real.
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const run = promisify(execFile);
const NAME = "ownership-control";
const DB = "00000000-0000-4000-8000-000000000001";
const worker = { name: NAME, id: "worker-control" };
const app = { name: `htmlgate: ${NAME}`, id: "app-control", type: "self_hosted", aud: "aud-control", destinations: [{ type: "worker", worker_id: worker.id }] };
const bindings = [
  { name: "DB", type: "d1", id: DB },
  { name: "BODIES", type: "r2_bucket", bucket_name: `${NAME}-bodies` },
];
const marker = { name: "HTMLGATE_INSTANCE", type: "plain_text", text: NAME };
const deployment = { deployments: [{ versions: [{ version_id: "serving", percentage: 100 }] }] };
type Scenario = {
  workers?: unknown; apps?: unknown; dbs?: unknown; deployment?: unknown; versions?: unknown;
  managed?: unknown; custom?: unknown; buckets?: unknown; r2Error?: string; lateApp?: boolean; endlessApps?: boolean; endlessWorkers?: boolean;
  bucketPageSize?: number; bucketPages?: Record<string, unknown>; endlessBuckets?: boolean;
};

async function setup(change: Scenario = {}) {
  mkdirSync(".scratch", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), ".scratch/setup-ownership-"));
  try {
    mkdirSync(join(dir, "scripts"));
    copyFileSync("scripts/setup.mjs", join(dir, "scripts/setup.mjs"));
    writeFileSync(join(dir, "instance.json"), JSON.stringify({ name: NAME, authorEmail: "author@example.com", allowlist: [] }));
    writeFileSync(join(dir, "scenario.json"), JSON.stringify({ workers: [worker], apps: [app], dbs: [{ name: `${NAME}-db`, uuid: DB }], deployment,
      versions: { serving: { resources: { bindings } } }, managed: { enabled: false }, custom: { domains: [] }, buckets: { buckets: [{ name: `${NAME}-bodies` }] }, ...change }));
    writeFileSync(join(dir, "provider.mjs"), String.raw`
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync, appendFileSync } from 'node:fs';
const s = JSON.parse(readFileSync(new URL('./scenario.json', import.meta.url)));
let created = false, createdDb = false;
const log = v => appendFileSync(new URL('./calls.jsonl', import.meta.url), JSON.stringify(v) + '\n');
cp.execFileSync = (bin, args) => {
  log({ bin: bin.endsWith('/wrangler') ? 'wrangler' : bin, args });
  const json = value => JSON.stringify(value);
const pageAt = args.indexOf('--page');
const page = pageAt < 0 ? 1 : Number(args[pageAt + 1]);
  if (bin === 'git') return '';
  if (bin.endsWith('/wrangler')) {
    if (args[0] === 'whoami') return json({ loggedIn: true, accounts: [{ id: 'account-control' }] });
    if (args[0] === 'versions') return json(s.versions[args[2]]);
    if (args[0] === 'd1' && args[1] === 'list') return json(createdDb ? [{ name: 'ownership-control-db', uuid: '${DB}' }] : s.dbs);
    if (args[0] === 'd1' && args[1] === 'create') { createdDb = true; return ''; }
    if (args[0] === 'deploy') {
      created = true;
      const c = JSON.parse(readFileSync(args[args.indexOf('-c') + 1], 'utf8').replace(/^\/\/[^\n]*\n/, ''));
      log({ deployed: c });
      return 'https://ownership-control.example.workers.dev';
    }
    if (args[0] === 'secret' && args[1] === 'list') return json([{ name: 'TICKET_KEY' }]);
    return '';
  }
  if (bin !== 'cf') throw new Error('unexpected provider ' + bin);
  if (args[0] === 'auth') return json({ tokenValid: true, accounts: [{ id: 'account-control' }] });
  if (args[1] === 'organizations') return json({ auth_domain: 'team.cloudflareaccess.com' });
  if (args[0] === 'workers' && args[1] === 'list') return json(s.endlessWorkers || page === 1 ? (created ? [{ name: 'ownership-control', id: 'worker-control' }] : s.workers) : []);
  if (args[0] === 'workers' && args[1] === 'deployments') return json(s.deployment);
  if (args[2] === 'applications') {
    if (args[3] === 'list') return json(s.lateApp
      ? (page === 1 ? [{ id: 'unrelated', name: 'unrelated', destinations: [] }] : page === 2 ? s.apps : [])
      : (s.endlessApps || page === 1 ? s.apps : []));
    return json({ aud: 'aud-control' });
  }
  if (args[0] === 'r2') {
    if (s.r2Error) throw new Error(s.r2Error);
    if (args[2] === 'list') {
      const offsetAt = args.indexOf('--start-after');
      const after = offsetAt < 0 ? '' : args[offsetAt + 1];
      if (s.bucketPages && Object.hasOwn(s.bucketPages, after)) return json(s.bucketPages[after]);
      if (s.endlessBuckets) return json({ buckets: [{ name: 'bucket-' + String(after ? Number(after.slice(7)) + 1 : 0).padStart(6, '0') }] });
      const rows = s.buckets?.buckets;
      if (!Array.isArray(rows)) return json(s.buckets);
      const perPage = Number(args[args.indexOf('--per-page') + 1]);
      return json({ ...s.buckets, buckets: rows.filter(b => !after || b?.name > after).slice(0, Math.min(perPage, s.bucketPageSize ?? perPage)) });
    }
    if (args[3] === 'managed') return json(s.managed);
    if (args[3] === 'custom') return json(s.custom);
  }
  throw new Error('unexpected command ' + args.join(' '));
};
syncBuiltinESMExports();
globalThis.fetch = async url => {
  const u = new URL(url);
  if (u.pathname === '/') return new Response(null, { status: 302, headers: { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/' + u.host + '?kid=aud-control' } });
  return new Response(null, { status: u.pathname.startsWith('/api/') ? 401 : 404 });
};
`);
    const result = await run(process.execPath, ["--import", join(dir, "provider.mjs"), join(dir, "scripts/setup.mjs")], {
      cwd: dir, env: { PATH: process.env.PATH }, timeout: 20_000,
    }).then(r => ({ code: 0, ...r }), (e: { code?: number; stdout: string; stderr: string; killed?: boolean }) => {
      expect(e.killed, "setup must finish without a command timeout").not.toBe(true);
      return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    });
    const calls = readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { bin?: string; args?: string[]; deployed?: Record<string, unknown> });
    const writes = calls.filter(c => c.args && (c.args.includes("create") || c.args.includes("update") || c.args.includes("apply") || c.args[0] === "deploy" || c.args[0] === "secret"));
    return { ...result, calls, writes };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("an existing database name never authorizes taking over an unrelated Worker", async () => {
  const r = await setup({ apps: [] });
  expect(r.code, r.stdout + r.stderr).toBe(1);
  expect(r.stderr).toMatch(/ownership|Instance|bootstrap/i);
  expect(r.writes).toEqual([]);
});

test.each([
  ["non-array object", { 0: { type: "worker", worker_id: worker.id } }],
  ["null container", null],
  ["null entry", [null]],
  ["primitive entry", ["worker"]],
  ["array entry", [[{ type: "worker", worker_id: worker.id }]]],
  ["missing Worker identity", [{ type: "worker" }]],
  ["non-string Worker identity", [{ type: "worker", worker_id: 42 }]],
  ["blank Worker identity", [{ type: "worker", worker_id: " " }]],
  ["missing preview Worker identity", [{ type: "preview_worker" }]],
  ["Worker identity without a type", [{ worker_id: worker.id }]],
  ["Worker identity on a public destination", [{ type: "public", uri: "other.example.com", worker_id: worker.id }]],
  ["unknown destination type", [{ type: "unknown_worker", worker_id: worker.id }]],
  ["unknown type without an identity", [{ type: "unrecognized" }]],
  ["non-string public URI", [{ uri: 42 }]],
] as const)("setup refuses malformed competing destinations: %s", async (_name, destinations) => {
  const r = await setup({ apps: [app, { ...app, id: "other-app", name: "another application", destinations }] });
  expect(r.writes).toEqual([]);
  expect(r.code, r.stdout + r.stderr).toBe(1);
  expect(r.stderr).toMatch(/malformed.*Access.*destination/i);
});

test.each([null, { 0: { type: "worker", worker_id: worker.id } }])("first setup refuses malformed competing destinations %j", async (destinations) => {
  const r = await setup({ workers: [], dbs: [], apps: [{ ...app, id: "other-app", name: "another application", destinations }] });
  expect(r.writes).toEqual([]);
  expect(r.code, r.stdout + r.stderr).toBe(1);
  expect(r.stderr).toMatch(/malformed.*Access.*destination/i);
});

test.each([
  ["legacy domain", { destinations: undefined, domain: "legacy.example.com" }],
  ["legacy hostnames", { destinations: undefined, self_hosted_domains: ["legacy.example.com"] }],
  ["SaaS app without destinations", { type: "saas", destinations: undefined }],
  ["empty destination list", { destinations: [] }],
  ["public URI", { destinations: [{ type: "public", uri: "other.example.com/path" }] }],
  ["public URI without its optional type", { destinations: [{ uri: "other.example.com/path" }] }],
  ["public type without its optional URI", { destinations: [{ type: "public" }] }],
  ["private hostname", { destinations: [{ type: "private", hostname: "internal.example.com", port_range: "443" }] }],
  ["MCP server portal", { destinations: [{ type: "via_mcp_server_portal", mcp_server_id: "another-server" }] }],
  ["another Worker", { destinations: [{ type: "worker", worker_id: "another-worker" }] }],
  ["another Worker's previews", { destinations: [{ type: "preview_worker", worker_id: "another-worker" }] }],
  ["this Worker's separate preview policy", { destinations: [{ type: "preview_worker", worker_id: worker.id }] }],
  ["overridden account-wide Worker policy", { destinations: [{ type: "all_workers" }] }],
  ["account-wide preview policy", { destinations: [{ type: "all_preview_workers" }] }],
] as const)("setup preserves an unrelated application with %s", async (_name, fields) => {
  const r = await setup({ apps: [app, { ...app, id: "other-app", name: "another application", ...fields }] });
  expect(r.code, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).toContain("Instance ready:");
  expect(r.writes.some(c => c.args?.includes("apply"))).toBe(true);
  const updates = r.writes.filter(c => c.bin === "cf" && c.args?.includes("update"));
  expect(updates).toHaveLength(1);
  expect(updates[0]?.args?.[4]).toBe(app.id);
});

test.each([
  ["foreign destination", { apps: [{ ...app, destinations: [{ type: "worker", worker_id: "someone-else" }] }] }],
  ["non-Worker destination", { apps: [{ ...app, destinations: [{ type: "public", uri: "https://foreign.example" }] }] }],
  ["missing destinations", { apps: [{ ...app, destinations: undefined }] }],
  ["duplicate applications", { apps: [app, { ...app, id: "duplicate" }] }],
  ["another application for the Worker", { apps: [app, { ...app, id: "duplicate", name: "foreign" }] }],
  ["duplicate Workers", { workers: [worker, { ...worker, id: "duplicate" }] }],
  ["duplicate Worker identity", { workers: [worker, { ...worker, name: "foreign" }] }],
  ["duplicate application identity", { apps: [app, { ...app, name: "foreign", destinations: [] }] }],
  ["malformed Worker list", { workers: {} }],
  ["malformed application list", { apps: {} }],
  ["incomplete application listing", { endlessApps: true }],
  ["incomplete Worker listing", { endlessWorkers: true }],
  ["missing database", { dbs: [] }],
  ["duplicate databases", { dbs: [{ name: `${NAME}-db`, uuid: DB }, { name: `${NAME}-db`, uuid: DB }] }],
  ["Access application without its Worker", { workers: [] }],
  ["no active deployment", { deployment: { deployments: [] } }],
  ["malformed active deployment", { deployment: {} }],
  ["non-array deployment list", { deployment: { deployments: { 0: { versions: [{ version_id: "serving", percentage: 100 }] } } } }],
  ["invalid traffic percentage", { deployment: { deployments: [{ versions: [{ version_id: "serving", percentage: "100" }] }] } }],
  ["incomplete traffic allocation", { deployment: { deployments: [{ versions: [{ version_id: "serving", percentage: 50 }] }] } }],
  ["duplicate serving versions", { deployment: { deployments: [{ versions: [{ version_id: "serving", percentage: 50 }, { version_id: "serving", percentage: 50 }] }] } }],
  ["missing bindings", { versions: { serving: { resources: {} } } }],
  ["wrong database UUID", { versions: { serving: { resources: { bindings: [{ ...bindings[0], id: "foreign" }, bindings[1]] } } } }],
  ["wrong bucket", { versions: { serving: { resources: { bindings: [bindings[0], { ...bindings[1], bucket_name: "foreign" }] } } } }],
  ["duplicate DB binding", { versions: { serving: { resources: { bindings: [...bindings, bindings[0]] } } } }],
  ["wrong DB binding type", { versions: { serving: { resources: { bindings: [{ ...bindings[0], type: "plain_text" }, bindings[1]] } } } }],
  ["a second traffic-serving version is foreign", { deployment: { deployments: [{ versions: [{ version_id: "serving", percentage: 50 }, { version_id: "other", percentage: 50 }] }] }, versions: { serving: { resources: { bindings } }, other: { resources: { bindings: [bindings[0]] } } } }],
  ["marker cannot override a foreign Access destination", { apps: [{ ...app, destinations: [{ type: "worker", worker_id: "foreign" }] }], versions: { serving: { resources: { bindings: [...bindings, marker] } } } }],
  ["wrong bootstrap marker", { apps: [], versions: { serving: { resources: { bindings: [...bindings, { ...marker, text: "foreign" }] } } } }],
  ["bootstrap marker on an already configured Worker", { apps: [], versions: { serving: { resources: { bindings: [...bindings, marker, { name: "ACCESS_AUD", type: "plain_text", text: "aud" }] } } } }],
] as const)("setup refuses %s before any remote write", async (_name, scenario) => {
  const r = await setup(scenario);
  expect(r.code, r.stdout + r.stderr).toBe(1);
  expect(r.writes).toEqual([]);
});

test.each([
  ["pre-marker Instance", {}],
  ["Access application on a later page", { lateApp: true }],
  ["marked Instance", { versions: { serving: { resources: { bindings: [...bindings, marker] } } } }],
  ["interrupted closed bootstrap", { apps: [], versions: { serving: { resources: { bindings: [...bindings, marker] } } } }],
  ["first setup", { apps: [], workers: [], dbs: [], buckets: { buckets: [] } }],
  ["pre-created storage", { apps: [], workers: [] }],
  ["two legitimate serving versions", { deployment: { deployments: [{ versions: [{ version_id: "serving", percentage: 20 }, { version_id: "older", percentage: 80 }, { version_id: "unused", percentage: 0 }] }] }, versions: { serving: { resources: { bindings } }, older: { resources: { bindings } } } }],
] as const)("setup preserves %s", async (_name, scenario) => {
  const r = await setup(scenario);
  expect(r.code, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).toContain("Instance ready:");
  expect(r.writes.some(c => c.args?.includes("apply"))).toBe(true);
  expect(r.writes.some(c => c.args?.[0] === "deploy")).toBe(true);
  if (_name === "two legitimate serving versions") {
    expect(r.calls.filter(c => c.args?.[0] === "versions").map(c => c.args)).toEqual([
      ["versions", "view", "serving", "--name", NAME, "--json"], ["versions", "view", "older", "--name", NAME, "--json"],
    ]);
  }
  if (_name === "first setup" || _name === "interrupted closed bootstrap") {
    const first = r.calls.find(c => c.deployed)?.deployed;
    expect(first).toMatchObject({ workers_dev: false, preview_urls: false, vars: { HTMLGATE_INSTANCE: NAME } });
    expect(first?.routes).toBeUndefined();
    expect(Object.keys(first!.vars as object)).toEqual(["HTMLGATE_INSTANCE"]);
  }
});

const unsafeBuckets = [
  ["enabled managed domain", { managed: { enabled: true } }],
  ["unknown managed privacy", { managed: {} }],
  ["nonboolean managed privacy", { managed: { enabled: "false" } }],
  ["enabled custom domain", { custom: { domains: [{ enabled: false }, { enabled: true }] } }],
  ["unknown custom privacy", { custom: {} }],
  ["non-array custom domains", { custom: { domains: {} } }],
  ["malformed custom domain", { custom: { domains: [null] } }],
  ["nonboolean custom privacy", { custom: { domains: [{ enabled: "false" }] } }],
  ["malformed bucket listing", { buckets: {} }],
] as const;

test.each(unsafeBuckets)("setup refuses reuse with %s before migrations or deploy", async (_name, scenario) => {
  const r = await setup(scenario);
  expect(r.code, r.stdout + r.stderr).toBe(1);
  expect(r.writes).toEqual([]);
});

test.each([
  ...unsafeBuckets,
  ["malformed bucket entry", { buckets: { buckets: [null] } }],
  ["duplicate buckets", { buckets: { buckets: [{ name: `${NAME}-bodies` }, { name: `${NAME}-bodies` }] } }],
  ["R2 subscription unavailable", { r2Error: "Please enable R2 [code: 10042]" }],
] as const)("first setup refuses %s before creating any resource", async (_name, scenario) => {
  const r = await setup({ apps: [], workers: [], dbs: [], ...scenario });
  expect(r.code, r.stdout + r.stderr).toBe(1);
  expect(r.stderr).toMatch(/R2|bucket|public|privacy/);
  expect(r.writes).toEqual([]);
  if (_name === "R2 subscription unavailable") expect(r.stderr).toContain("complete the checkout to add the R2 subscription");
});

test("a reused bucket with every custom domain explicitly disabled remains usable", async () => {
  const r = await setup({ custom: { domains: [{ enabled: false }, { enabled: false }] } });
  expect(r.code, r.stdout + r.stderr).toBe(0);
  const privacy = r.calls.filter(c => c.args?.includes("domains")).map(c => c.args);
  expect(privacy).toEqual([
    ["r2", "buckets", "domains", "managed", "list", "--bucket-name", `${NAME}-bodies`],
    ["r2", "buckets", "domains", "custom", "list", "--bucket-name", `${NAME}-bodies`],
  ]);
});

const laterBucket = { buckets: { buckets: [{ name: "alpha-bucket" }, { name: `${NAME}-bodies` }] }, bucketPageSize: 1 };
const emptyInstance = { workers: [], apps: [], dbs: [] };

test.each([false, true])("setup reuses a private bucket after a short first page (first setup: %s)", async (first) => {
  const r = await setup({ ...laterBucket, ...(first ? emptyInstance : {}) });
  expect(r.code, r.stdout + r.stderr).toBe(0);
  expect(r.writes.filter(c => c.args?.[0] === "r2")).toEqual([]);
  const lists = r.calls.filter(c => c.args?.[0] === "r2" && c.args[2] === "list");
  const args = ["r2", "buckets", "list", "--per-page", "1000", "--order", "name", "--direction", "asc"];
  expect(lists.map(c => c.args)).toEqual([args, [...args, "--start-after", "alpha-bucket"], [...args, "--start-after", `${NAME}-bodies`]]);
  expect(r.calls.filter(c => c.args?.includes("domains")).map(c => c.args)).toEqual([
    ["r2", "buckets", "domains", "managed", "list", "--bucket-name", `${NAME}-bodies`],
    ["r2", "buckets", "domains", "custom", "list", "--bucket-name", `${NAME}-bodies`],
  ]);
  expect(r.calls.indexOf(r.writes[0]!)).toBeGreaterThan(r.calls.indexOf(lists.at(-1)!));
});

test.each(([
  ["public managed domain", { managed: { enabled: true } }],
  ["unknown managed privacy", { managed: {} }],
  ["public custom domain", { custom: { domains: [{ enabled: true }] } }],
  ["unknown custom privacy", { custom: {} }],
] as const).flatMap(([name, scenario]) => [false, true].map(first => [name, first, scenario] as const)))("setup refuses a later bucket with %s before writes (first setup: %s)", async (_name, first, scenario) => {
  const r = await setup({ ...laterBucket, ...(first ? emptyInstance : {}), ...scenario });
  expect(r.writes).toEqual([]);
  expect(r.code, r.stdout + r.stderr).toBe(1);
  expect(r.stderr).toMatch(/bucket.*public|privacy/i);
});

test.each([
  ["repeated page", { "alpha-bucket": { buckets: [{ name: "alpha-bucket" }] } }],
  ["backward page", { "alpha-bucket": { buckets: [{ name: "aardvark-bucket" }] } }],
  ["unordered page", { "alpha-bucket": { buckets: [{ name: "zulu-bucket" }, { name: "beta-bucket" }] } }],
  ["duplicate unrelated names", { "alpha-bucket": { buckets: [{ name: "beta-bucket" }, { name: "beta-bucket" }] } }],
  ["malformed response", { "alpha-bucket": {} }],
  ["missing name", { "alpha-bucket": { buckets: [{}] } }],
  ["non-string name", { "alpha-bucket": { buckets: [{ name: 42 }] } }],
  ["empty name", { "alpha-bucket": { buckets: [{ name: "" }] } }],
  ["duplicate target after a match", { [`${NAME}-bodies`]: { buckets: [{ name: `${NAME}-bodies` }] } }],
  ["unconfirmed completion after a match", { [`${NAME}-bodies`]: {} }],
] as const)("setup refuses %s in later bucket pages before any write", async (_name, bucketPages) => {
  const r = await setup({ ...laterBucket, ...emptyInstance, bucketPages });
  expect(r.writes).toEqual([]);
  expect(r.code, r.stdout + r.stderr).toBe(1);
  expect(r.stderr).toMatch(/R2 bucket|bucket.*name/i);
});

test("setup refuses a bucket listing that never reaches an empty page", async () => {
  const r = await setup({ ...emptyInstance, endlessBuckets: true });
  expect(r.writes).toEqual([]);
  expect(r.code, r.stdout + r.stderr).toBe(1);
  expect(r.stderr).toContain("past page 1000");
});
