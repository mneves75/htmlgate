#!/usr/bin/env node
// The htmlgate CLI: its grammar, output modes, agent detection and exit codes, parsed with node:util parseArgs.
import { basename, extname } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { InstanceApi, type Share, type Fields } from "./api.js";
import { checkToken, checkWritable, forget, instanceOrigin, paths, resolve, save, selectInstance, type Paths } from "./config.js";
import { CliError, exitCodeFor } from "./errors.js";
import { loadPublishable, parseExpires, parseMetadata } from "./files.js";
import { readHidden, readStdin } from "./prompt.js";
import { setAgent, VERSION } from "./useragent.js";

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
}

// Agent runners whose presence makes JSON the default output.
const AGENT_ENV_VARS: ReadonlyArray<readonly [string, string]> = [
  ["CLAUDECODE", "claude-code"], ["CLAUDE_CODE", "claude-code"], ["CURSOR_AGENT", "cursor"], ["CODEX", "codex"],
  ["CODEX_AGENT", "codex"], ["OPENAI_CODEX", "codex"], ["OPENCODE", "opencode"], ["AIDER", "aider"], ["CLINE", "cline"],
  ["WINDSURF_AGENT", "windsurf"], ["GITHUB_COPILOT", "github-copilot"], ["AMAZON_Q", "amazon-q"], ["AWS_Q_DEVELOPER", "amazon-q"],
  ["GEMINI_CODE_ASSIST", "gemini-code-assist"], ["SRC_CODY", "sourcegraph-cody"], ["PI_CODING_AGENT", "pi"], ["AMP_CODE", "amp"],
  ["DEVIN", "devin"], ["AGENT", "generic-agent"],
];

function detectAgent(env: NodeJS.ProcessEnv): string | null {
  if (env.FORCE_AGENT_MODE) return "forced";
  for (const [key, name] of AGENT_ENV_VARS) if (env[key]) return name;
  return null;
}

const HELP = `htmlgate ${VERSION}: publish HTML to your htmlgate Instance and get a URL.

Usage:
  htmlgate login <instance-url> [--token-stdin]
  htmlgate logout [<instance-url>]
  htmlgate status
  htmlgate publish <page.html | site.zip | folder> [--title <t>] [--description <d>] [--metadata k=v]...
                   [--upsert | --slug <slug>] [--expires <30d|12h|2026-12-31|never>]
  htmlgate update <slug> [--file <f>] [--title <t>] [--description <d>] [--metadata k=v]... [--clear-metadata]
                  [--expires <when>]
  htmlgate list [--metadata k=v]... [--public | --gated] [-n <count>]
  htmlgate url <slug>
  htmlgate delete <slug>
  htmlgate public <slug>
  htmlgate gate <slug>
  htmlgate versions <slug>
  htmlgate tokens list
  htmlgate tokens revoke <id>

Global options: --output text|json, --help, --version
Sign-in: \`htmlgate login\`, or $HTMLGATE_URL with $HTMLGATE_TOKEN. Exit codes: 2 auth, 3 forbidden,
4 not found, 5 limit, 6 too large, 7 bad arguments, 8 network or server.
`;

// Tokens are never printed, whatever path an error or a server message takes to the terminal.
const redact = (s: string) => s.replace(/hg_[A-Za-z0-9]{40}/g, "hg_…");

let json = detectAgent(process.env) !== null;

// Text a server sent (a Share's title, say) must not reach the terminal as escape sequences or reorder it.
const printable = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
// One field of a row: a newline or tab inside it would forge another row or column.
const cell = (s: string) => s.replace(/[\t\n]/g, " ");

function emit(payload: unknown, text: () => string): void {
  process.stdout.write(redact(json ? JSON.stringify(payload) + "\n" : printable(text())));
}

function die(err: unknown): never {
  const e = err instanceof CliError ? err : new CliError("unknown", (err as Error)?.message ?? String(err));
  if (json) {
    const body: Record<string, unknown> = { code: e.code, message: e.message };
    if (e.hint) body.hint = e.hint;
    if (e.details) body.details = e.details;
    process.stderr.write(redact(JSON.stringify({ error: body })) + "\n");
  } else {
    // A server writes the message: each part stays on its one line, so it cannot fake a hint or another error.
    let out = `error: ${cell(e.message)}  [${cell(e.code)}]\n`;
    if (e.hint) out += `hint:  ${cell(e.hint)}\n`;
    process.stderr.write(redact(printable(out)));
  }
  process.exit(exitCodeFor(e.code));
}

const GLOBAL = {
  output: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const satisfies ParseArgsConfig["options"];

const OPTIONS = {
  login: { "token-stdin": { type: "boolean" } },
  logout: {},
  status: {},
  publish: { title: { type: "string" }, description: { type: "string" }, metadata: { type: "string", multiple: true }, upsert: { type: "boolean" }, slug: { type: "string" }, expires: { type: "string" } },
  update: { file: { type: "string" }, title: { type: "string" }, description: { type: "string" }, metadata: { type: "string", multiple: true }, "clear-metadata": { type: "boolean" }, expires: { type: "string" } },
  list: { metadata: { type: "string", multiple: true }, public: { type: "boolean" }, gated: { type: "boolean" }, limit: { type: "string", short: "n" } },
  url: {}, delete: {}, public: {}, gate: {}, versions: {}, tokens: {},
} as const satisfies Record<string, ParseArgsConfig["options"]>;

type Command = keyof typeof OPTIONS;
const isCommand = (s: string | undefined): s is Command => s !== undefined && Object.hasOwn(OPTIONS, s);

/** Parses argv for one command; anything unknown is a usage error, exit 7. */
function parse(argv: string[]) {
  const first = parseArgs({ args: argv, options: GLOBAL, strict: false, allowPositionals: true });
  // Set before anything below can fail, so a usage error honours --output too.
  if (first.values.output === "json" || first.values.output === "text") json = first.values.output === "json";
  const name = first.positionals[0];
  if (first.values.version === true) return { cmd: "version" as const };
  if (first.values.help === true || name === undefined) return { cmd: "help" as const, error: name === undefined && first.values.help !== true };
  if (!isCommand(name)) throw new CliError("invalid_arg", `Unknown command "${name}".`, { hint: "Run `htmlgate --help`." });
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { ...GLOBAL, ...OPTIONS[name] }, strict: true, allowPositionals: true });
  } catch (e) {
    throw new CliError("invalid_arg", (e as Error).message, { hint: "Run `htmlgate --help`." });
  }
  const output = parsed.values.output;
  if (output !== undefined && output !== "json" && output !== "text") throw new CliError("invalid_arg", "--output is text or json.");
  if (output !== undefined) json = output === "json";
  return { cmd: name, args: parsed.positionals.slice(1), values: parsed.values as Record<string, string | boolean | string[] | undefined> };
}

function arg(args: string[], i: number, what: string): string {
  const v = args[i];
  if (v === undefined || v === "") throw new CliError("invalid_arg", `Missing ${what}.`, { hint: "Run `htmlgate --help`." });
  return v;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const list = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
const defaultTitle = (file: string) => basename(file, extname(file)) || "untitled";
const brief = (d: Share) => ({ slug: d.slug, url: d.url, public: d.public });
const minute = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const expiresText = (at: number | null | undefined) => (typeof at === "number" ? minute(at) + " UTC" : "never");
/** --expires, when given, as the API's expires_at. */
const expiresOf = (v: Record<string, unknown>): { expires_at?: number | null } =>
  typeof v.expires === "string" ? { expires_at: parseExpires(v.expires, Date.now()) } : {};

async function connect(p: Paths): Promise<InstanceApi> {
  return (await signedIn(p)).api;
}

/** The Instance, token and where each came from, with a client for them. */
async function signedIn(p: Paths) {
  const c = await resolve(p, process.env);
  return { ...c, api: new InstanceApi(c.api_url, c.token) };
}

async function login(p: Paths, args: string[], values: Record<string, unknown>) {
  // Never from a project's .htmlgate/config: a cloned repository would collect the token through the check below.
  const envUrl = process.env.HTMLGATE_URL?.trim();
  const envToken = process.env.HTMLGATE_TOKEN?.trim();
  const raw = args[0] ?? envUrl;
  if (!raw) throw new CliError("invalid_arg", "Name the Instance to sign in to: htmlgate login <instance-url>.");
  const origin = instanceOrigin(raw);
  await checkWritable(p);
  let token: string;
  if (values["token-stdin"] === true) token = await readStdin();
  // The environment's token belongs to the Instance $HTMLGATE_URL names; never send it to another one.
  else if (envToken && envUrl && instanceOrigin(envUrl) === origin) token = envToken;
  else if (process.stdin.isTTY && process.stderr.isTTY) {
    process.stderr.write(`Create a token at ${origin}/tokens, then paste it here.\n`);
    token = await readHidden("Token: ");
  } else {
    throw new CliError("auth_required", "No token to sign in with.", {
      hint: `Create one at ${origin}/tokens, then pass it on stdin with --token-stdin, or in HTMLGATE_TOKEN with HTMLGATE_URL=${origin}.`,
    });
  }
  token = checkToken(token.trim());
  // Ask the Instance before writing anything: a refused token leaves the old files as they were.
  await new InstanceApi(origin, token).listShares({ pageSize: 1 });
  await save(p, origin, token);
  emit({ api_url: origin, saved: p.store }, () => `Signed in to ${origin}. The token is in ${p.store}.\n`);
}

async function publish(p: Paths, args: string[], v: Record<string, unknown>) {
  const file = arg(args, 0, "the HTML file, .zip or folder to publish");
  const slug = str(v.slug);
  if (slug === "") throw new CliError("invalid_arg", "--slug needs the Share's slug.");
  const metadata = parseMetadata(list(v.metadata));
  const hasMeta = Object.keys(metadata).length > 0;
  if (slug && v.upsert) throw new CliError("invalid_arg", "--slug and --upsert are mutually exclusive.", { hint: "--slug names the Share; --upsert finds it by --metadata." });
  if (v.upsert && !hasMeta) throw new CliError("invalid_arg", "--upsert needs at least one --metadata key=value to match on.");
  const expiry = expiresOf(v);
  const { filePath, content } = await loadPublishable(file);
  const title = str(v.title)?.trim() || defaultTitle(filePath);
  const description = str(v.description);
  const created: Fields & { title: string } = { title, ...(description ? { description } : {}), ...(hasMeta ? { metadata } : {}), ...expiry };
  const api = await connect(p);

  let target = slug;
  let matched: boolean | undefined;
  if (v.upsert) {
    const found = await api.listShares({ metadata, pageSize: 10 });
    if (found.total > 1) {
      throw new CliError("ambiguous_upsert", `${found.total} Shares match that metadata: ${found.data.map((d) => d.slug).join(", ")}. The CLI will not guess which to update.`, {
        hint: "Use --slug to name one, or delete the extras.",
      });
    }
    target = found.data[0]?.slug;
    matched = target !== undefined;
  }
  // A new Version of an existing Share changes only what it was given: the default title (the file name) would
  // overwrite a title chosen earlier, and a matched upsert's match keys would replace the whole tag map.
  const given = str(v.title)?.trim();
  const fields: Fields = { ...(given ? { title: given } : {}), ...(description ? { description } : {}), ...expiry };
  const d = target ? await api.replace(target, content, matched ? fields : { ...fields, ...(hasMeta ? { metadata } : {}) }) : await api.publish(content, created);
  // Scripts read the URL from the first line; a person at a terminal also sees when the Share expires.
  emit({ url: d.url, slug: d.slug, kind: content.kind, expires_at: d.expires_at, ...(matched !== undefined ? { matched } : {}) },
    () => d.url + "\n" + (process.stdout.isTTY ? `expires: ${expiresText(d.expires_at)}\n` : ""));
}

async function update(p: Paths, args: string[], v: Record<string, unknown>) {
  const slug = arg(args, 0, "the Share's slug");
  const meta = list(v.metadata);
  if (meta.length && v["clear-metadata"]) throw new CliError("invalid_arg", "--metadata and --clear-metadata are mutually exclusive.");
  const metadata = v["clear-metadata"] ? {} : meta.length ? parseMetadata(meta) : undefined;
  const title = str(v.title);
  const description = str(v.description);
  const fields: Fields = { ...(title ? { title } : {}), ...(description !== undefined ? { description } : {}), ...(metadata ? { metadata } : {}), ...expiresOf(v) };
  const file = str(v.file);
  if (!file && Object.keys(fields).length === 0) {
    throw new CliError("invalid_arg", "update needs --file, --title, --description, --metadata, --clear-metadata or --expires.");
  }
  const content = file ? (await loadPublishable(file)).content : undefined;
  // A zip carries its fields in the query string, where an empty tag map cannot be said.
  if (content?.kind === "site" && v["clear-metadata"]) {
    throw new CliError("invalid_arg", "--clear-metadata cannot go with a site's --file.", { hint: "Run update --clear-metadata on its own first." });
  }
  const api = await connect(p);
  const d = content !== undefined ? await api.replace(slug, content, fields) : await api.patch(slug, fields);
  const mode = content !== undefined ? "put" : "patch";
  emit({ url: d.url, slug: d.slug, mode }, () => `${mode === "put" ? "updated (new version)" : "patched"}: ${d.url}\n`);
}

async function listShares(p: Paths, v: Record<string, unknown>) {
  if (v.public && v.gated) throw new CliError("invalid_arg", "--public and --gated are mutually exclusive.");
  const limitRaw = str(v.limit);
  if (limitRaw !== undefined && !/^[1-9][0-9]*$/.test(limitRaw)) throw new CliError("invalid_arg", `-n must be a positive whole number (got ${limitRaw}).`);
  const limit = limitRaw === undefined ? Infinity : Number(limitRaw);
  const metadata = parseMetadata(list(v.metadata));
  const api = await connect(p);
  const rows: Share[] = [];
  for (let page = 1; rows.length < limit; page++) {
    const res = await api.listShares({ page, pageSize: 200, metadata, ...(v.public ? { public: true } : v.gated ? { public: false } : {}) });
    rows.push(...res.data);
    if (page >= res.totalPages || res.data.length === 0) break;
  }
  const out = rows.slice(0, limit).map((d) => ({
    slug: d.slug, title: d.title, url: d.url, public: d.public, updated_at: new Date(d.updated_at).toISOString(), metadata: d.metadata ?? {},
    expires_at: typeof d.expires_at === "number" ? new Date(d.expires_at).toISOString() : null,
  }));
  emit(out, () => {
    if (out.length === 0) return "(no shares)\n";
    if (process.stdout.isTTY) {
      return table(out.map((r) => [r.slug, r.public ? "public" : "gated", r.updated_at.slice(0, 16).replace("T", " "), r.expires_at?.slice(0, 10) ?? "never", r.title, r.url]),
        ["SLUG", "STATE", "UPDATED", "EXPIRES", "TITLE", "URL"]);
    }
    return out.map((r) => [r.slug, r.updated_at, r.title, r.url].map(cell).join("\t")).join("\n") + "\n";
  });
}

function table(cells: string[][], head: string[]): string {
  const rows = cells.map((r) => r.map(cell));
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(head), ...rows.map(line)].join("\n") + "\n";
}

async function tokens(p: Paths, args: string[]) {
  const sub = arg(args, 0, "tokens list or tokens revoke <id>");
  if (sub !== "list" && sub !== "revoke") throw new CliError("invalid_arg", `Unknown tokens command "${sub}". Use list or revoke.`);
  const id = sub === "revoke" ? arg(args, 1, "the token id from `htmlgate tokens list`") : "";
  if (sub === "revoke" && !/^[0-9a-f]{12}$/.test(id)) throw new CliError("invalid_token_id", `"${id}" is not a token id: 12 hex characters, from \`htmlgate tokens list\`.`);
  const api = await connect(p);
  if (sub === "list") {
    const all = await api.tokens();
    emit(all, () => table(all.map((t) => [t.id, t.name, t.revoked_at ? "revoked" : "live", t.last_used_at ? minute(t.last_used_at) : "never"]), ["ID", "NAME", "STATE", "LAST USED"]));
  } else {
    await api.revokeToken(id);
    emit({ revoked: true, id }, () => `revoked ${id}\n`);
  }
}

async function main(): Promise<void> {
  const parsed = parse(process.argv.slice(2));
  if (parsed.cmd === "version") return void process.stdout.write(VERSION + "\n");
  if (parsed.cmd === "help") {
    if (parsed.error && json) throw new CliError("invalid_arg", "Name a command.", { hint: "Run `htmlgate --help`." });
    (parsed.error ? process.stderr : process.stdout).write(HELP);
    if (parsed.error) process.exit(7);
    return;
  }
  setAgent(detectAgent(process.env));
  const p = paths(process.cwd(), process.env);
  const { cmd, args, values } = parsed;
  switch (cmd) {
    case "login":
      return login(p, args, values);
    case "logout": {
      const origin = args[0] ? instanceOrigin(args[0]) : (await selectInstance(p, process.env)).api_url;
      const removed = await forget(p, origin);
      return emit({ removed, api_url: origin }, () => (removed ? `Signed out of ${origin}. The token still works until it is revoked.\n` : `Not signed in to ${origin}.\n`));
    }
    case "status": {
      const c = await signedIn(p);
      await c.api.listShares({ pageSize: 1 });
      return emit({ api_url: c.api_url, instance_from: c.instanceFrom, token_from: c.tokenFrom },
        () => `Signed in to ${c.api_url} (Instance from ${c.instanceFrom}, token from ${c.tokenFrom}).\n`);
    }
    case "publish":
      return publish(p, args, values);
    case "update":
      return update(p, args, values);
    case "list":
      return listShares(p, values);
    case "url": {
      const d = await (await connect(p)).getShare(arg(args, 0, "the Share's slug"));
      return emit({ url: d.url, slug: d.slug }, () => d.url + "\n");
    }
    case "delete": {
      const slug = arg(args, 0, "the Share's slug");
      await (await connect(p)).remove(slug);
      return emit({ deleted: true, slug }, () => `deleted ${slug}\n`);
    }
    case "public":
    case "gate": {
      const d = await (await connect(p)).setPublic(arg(args, 0, "the Share's slug"), cmd === "public");
      return emit(brief(d), () => `${d.public ? "public" : "gated"}: ${d.url}\n`);
    }
    case "versions": {
      const all = await (await connect(p)).versions(arg(args, 0, "the Share's slug"));
      return emit(all, () => table(all.map((x) => [`v${x.n}`, x.kind, `${x.size} B`, minute(x.created_at), x.token.name ?? "-"]), ["VERSION", "KIND", "SIZE", "CREATED", "TOKEN"]));
    }
    case "tokens":
      return tokens(p, args);
  }
}

main().catch(die);
