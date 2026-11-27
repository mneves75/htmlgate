#!/usr/bin/env node
import { createHash, randomInt } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bodiesBucket, cf, checkOwnership, checkSameAccount, findDatabase, generatedConfig, isDefaultBucketJurisdiction, listApplications, listWorkers, putTicketKey, readInstance, wranglerWho } from "./setup.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = join(ROOT, "node_modules/.bin/wrangler");
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const newToken = () => "hg_" + Array.from({ length: 40 }, () => ALPHABET[randomInt(62)]).join("");
const hex = (n) => Array.from({ length: n }, () => randomInt(16).toString(16)).join("");

export function parseArgs(argv) {
  const flags = { config: "instance.json", local: false, persistTo: undefined };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) throw new Error("--config requires a path.");
      flags.config = value;
    } else if (a === "--persist-to") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) throw new Error("--persist-to requires a directory.");
      flags.persistTo = value;
    } else if (a === "--local") {
      flags.local = true;
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown flag "${a}". Use --config <path>, --local, or --persist-to <dir>.`);
    } else {
      rest.push(a);
    }
  }
  if (rest.length > 2) throw new Error(`Unexpected argument "${rest[2]}".`);
  if (flags.local && !flags.persistTo) throw new Error("--local needs --persist-to <dir>.");
  return { cmd: rest[0], arg: rest[1], flags };
}

function d1(sql, inst, flags, targetConfig, statements = 1) {
  const args = ["d1", "execute", flags.local ? "htmlgate-dev" : `${inst.name}-db`, "--json", "--command", sql];
  if (flags.local) args.push("--local", "--persist-to", flags.persistTo, "-c", join(ROOT, "wrangler.jsonc"));
  else args.push("--remote", "-c", targetConfig ?? generatedConfig(inst));
  const out = execFileSync(WRANGLER, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
  const receipt = JSON.parse(out);
  if (!Array.isArray(receipt) || receipt.length !== statements || receipt.some((result) => result?.success !== true || !Array.isArray(result.results))) {
    throw new Error("Wrangler did not confirm the database operation.");
  }
  return receipt.at(-1);
}

const CLOCK = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

/**
 * revoke-all's token step, one statement per D1 call and in this order. The table is created first, so the step works
 * on a database that predates migration 0009. The revocation time is recorded before the tokens are revoked: from then
 * on Store.createToken refuses any Access sign-in issued before it, including a request already inside the Worker, so
 * no token can be minted after the UPDATE by a session that started before revoke-all.
 */
export function revokeTokenStatements(now) {
  return [
    "CREATE TABLE IF NOT EXISTS revocations (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL)",
    `INSERT INTO revocations (id, at) VALUES (1, ${CLOCK}) ON CONFLICT (id) DO UPDATE SET at = MAX(at, excluded.at)`,
    `UPDATE tokens SET revoked_at = ${now} WHERE revoked_at IS NULL`,
  ];
}

export function revokeAll({ checkAccount, revokeSessions, revokeTokens, rotateTicketKey }, { local, say }) {
  const steps = local
    ? [["Tokens", revokeTokens]]
    : [["Account", checkAccount], ["Access sign-ins", revokeSessions], ["Tokens", revokeTokens], ["Ticket key", rotateTicketKey]];
  for (const [name, step] of steps) {
    let result;
    try {
      result = step();
    } catch (e) {
      throw new Error(`${name}: ${e.message}\nThe steps after it did not run. Every step is safe to repeat: run pnpm run token revoke-all again.`);
    }
    say(`${name}: ${result}.`);
  }
  if (local) say("--local: the ticket key and Access sign-ins belong to a deployed Instance and were not touched.");
}

function revocationTarget(inst, accountId) {
  const db = findDatabase(inst);
  const { worker, app } = checkOwnership(inst, db, listWorkers(cf), listApplications(), { requireAppAudience: true });
  if (!worker || !app) throw new Error("Could not establish ownership of a deployed Instance and its Access application.");

  const generated = JSON.parse(readFileSync(generatedConfig(inst), "utf8").replace(/^\/\/[^\n]*\n/, ""));
  const database = generated?.d1_databases;
  const buckets = generated?.r2_buckets;
  if (generated?.name !== worker.name || (Object.hasOwn(generated, "account_id") && generated.account_id !== accountId)
    || !Array.isArray(database) || database.length !== 1 || database[0]?.binding !== "DB" || database[0].database_id !== db.uuid || database[0].database_name !== db.name
    || !Array.isArray(buckets) || buckets.length !== 1 || buckets[0]?.binding !== "BODIES" || buckets[0].bucket_name !== bodiesBucket(inst) || !isDefaultBucketJurisdiction(buckets[0].jurisdiction)
    || generated.vars?.ACCESS_AUD !== app.aud || (Object.hasOwn(generated.vars, "HTMLGATE_INSTANCE") && generated.vars.HTMLGATE_INSTANCE !== inst.name)) {
    throw new Error("The generated configuration does not match the verified Instance target. Check the config and run setup before retrying.");
  }
  return { appId: app.id, config: { account_id: accountId, name: worker.name, d1_databases: [{ binding: "DB", database_name: db.name, database_id: db.uuid }] } };
}

function servingVersions(inst) {
  const versions = cf("workers", "deployments", "list", "--worker", inst.name, "--page", "1", "--per-page", "1")?.deployments?.[0]?.versions;
  if (!Array.isArray(versions) || !versions.length || versions.some((v) => typeof v?.version_id !== "string" || typeof v.percentage !== "number")) {
    throw new Error("cf did not return the Worker's active deployment");
  }
  return versions;
}

function revokeSessions(appId) {
  const result = cf("zero-trust", "access", "applications", "revoke-tokens", appId, "--force");
  // cf prints the result of Cloudflare's successful response, an empty object.
  if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).length !== 0) throw new Error("cf did not confirm the session revocation");
  return "revoked; everyone signs in again";
}

function main() {
  const { cmd, arg, flags } = parseArgs(process.argv.slice(2));
  const inst = readInstance(resolve(ROOT, flags.config));
  if (!flags.local && !existsSync(generatedConfig(inst))) {
    throw new Error(`${generatedConfig(inst)} does not exist. Run \`pnpm run setup --config ${flags.config}\` first.`);
  }

  if (cmd === "create") {
    if (!arg || !/^[A-Za-z0-9 ._-]{1,64}$/.test(arg)) throw new Error("Give the token a name: 1 to 64 letters, digits, spaces, '.', '_' or '-'.");
    const token = newToken();
    const digest = createHash("sha256").update(token).digest("hex");
    d1(`INSERT INTO tokens (id, author, name, digest, created_at) VALUES ('${hex(12)}', '${inst.author.replace(/'/g, "''")}', '${arg}', '${digest}', ${Date.now()})`, inst, flags);
    console.error(`Token "${arg}" created. It is shown once; store it where your Publisher reads it.`);
    console.log(token);
  } else if (cmd === "list") {
    for (const t of d1("SELECT id, name, created_at, last_used_at, revoked_at FROM tokens ORDER BY created_at DESC", inst, flags).results) {
      const when = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16) : "never");
      const name = t.name.replace(/(?![\u200c\u200d])[\p{Cc}\p{Cf}]/gu, "");
      console.log(`${t.id}  ${name.padEnd(24)} created ${when(t.created_at)}  last used ${when(t.last_used_at)}  ${t.revoked_at ? "REVOKED" : "live"}`);
    }
  } else if (cmd === "revoke") {
    if (!arg || !/^[0-9a-f]{12}$/.test(arg)) throw new Error("Give the token id (12 hex characters) from `pnpm run token list`.");
    const changed = d1(`UPDATE tokens SET revoked_at = ${Date.now()} WHERE id = '${arg}' AND revoked_at IS NULL RETURNING id`, inst, flags).results;
    if (changed[0]?.id === arg) console.log(`Token ${arg} revoked.`);
    else if (d1(`SELECT id FROM tokens WHERE id = '${arg}' AND revoked_at IS NOT NULL`, inst, flags).results[0]?.id === arg) {
      console.log(`Token ${arg} was already revoked.`);
    } else throw new Error(`No token ${arg} exists.`);
  } else if (cmd === "revoke-all") {
    let directory, targetConfig, appId;
    try {
      revokeAll({
        checkAccount: () => {
          const accountId = checkSameAccount(wranglerWho(), cf("auth", "whoami"), process.env);
          const target = revocationTarget(inst, accountId);
          appId = target.appId;
          directory = mkdtempSync(join(dirname(generatedConfig(inst)), ".revoke-"));
          targetConfig = join(directory, "wrangler.json");
          writeFileSync(targetConfig, JSON.stringify(target.config), { mode: 0o600 });
          return "Wrangler and cf target the verified Instance";
        },
        revokeTokens: () => {
          const [table, marker, update] = revokeTokenStatements(Date.now());
          d1(table, inst, flags, targetConfig);
          d1(marker, inst, flags, targetConfig);
          // Wrangler's local JSON keeps only duration in meta. Its batch runs both statements on the same D1 connection.
          const count = flags.local
            ? d1(`${update}; SELECT changes() AS count`, inst, flags, targetConfig, 2).results[0]?.count
            : d1(update, inst, flags, targetConfig).meta?.changes;
          if (!Number.isSafeInteger(count) || count < 0) throw new Error("Wrangler did not confirm the number of revoked tokens.");
          return `${count} revoked`;
        },
        rotateTicketKey: () => {
          const before = new Set(servingVersions(inst).map((v) => v.version_id));
          putTicketKey(targetConfig);
          // A version still in the active deployment, even at 0%, answers a version override and accepts old tickets.
          const after = servingVersions(inst);
          if (after.length !== 1 || after[0].percentage !== 100 || before.has(after[0].version_id)) {
            throw new Error("the new key was uploaded, but the active deployment still holds a version from before it, which accepts the old tickets. Run pnpm run setup so one version serves 100%, then run revoke-all again");
          }
          return "replaced; every open ticket has ended";
        },
        revokeSessions: () => revokeSessions(appId),
      }, { local: flags.local, say: (line) => console.log(line) });
    } finally {
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  } else {
    throw new Error("Usage: pnpm run token create <name> | list | revoke <id> | revoke-all");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`token failed: ${e.message}`);
    process.exit(1);
  }
}
