#!/usr/bin/env node
// The Operator's token command. It runs with the Operator's own Cloudflare login, which is as strong
// as signing in to the token page, so it may create tokens (issue #13). Needs a prior `pnpm run setup`.
//
// Usage: pnpm run token create <name> | list | revoke <id> | revoke-all   [--config <file>] [--local --persist-to <dir>]
// --local acts on a `wrangler dev` database instead of the deployed one (used by the tests).
import { createHash, randomInt } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cf, checkSameAccount, generatedConfig, listApplications, putTicketKey, readInstance, sh, wranglerWho } from "./setup.mjs";

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
    if (a === "--config") flags.config = argv[++i];
    else if (a === "--persist-to") flags.persistTo = argv[++i];
    else if (a === "--local") flags.local = true;
    else rest.push(a);
  }
  if (flags.local && !flags.persistTo) throw new Error("--local needs --persist-to <dir>.");
  return { cmd: rest[0], arg: rest[1], flags };
}

function d1(sql, inst, flags) {
  const args = ["d1", "execute", flags.local ? "htmlgate-dev" : `${inst.name}-db`, "--json", "--command", sql];
  if (flags.local) args.push("--local", "--persist-to", flags.persistTo, "-c", join(ROOT, "wrangler.jsonc"));
  else args.push("--remote", "-c", generatedConfig(inst));
  const out = execFileSync(WRANGLER, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
  return JSON.parse(out)[0]?.results ?? [];
}

/**
 * Ends every way in, for a lost laptop or a leaked token. First it checks that Wrangler and cf act on the same account,
 * because cf finds the Access application by name and a name is not an account. Then every Access sign-in to the
 * Instance, so a stolen session cannot make a token while the rest runs; then every token; then every open ticket (a new
 * TICKET_KEY). A failed step stops the rest; each step is safe to repeat, so the fix is to run the command again. A
 * local database has only tokens.
 */
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

/** Ends every Access session for the Instance's application, so everyone signs in again. */
function revokeSessions(inst) {
  const name = `htmlgate: ${inst.name}`;
  const apps = listApplications().filter((a) => a.name === name);
  if (apps.length !== 1) throw new Error(`expected one Access application named "${name}", found ${apps.length}`);
  // Without --force cf asks, gets no answer, prints "Aborted." and still exits 0.
  const out = sh("cf", ["zero-trust", "access", "applications", "revoke-tokens", apps[0].id, "--force"]);
  if (/aborted/i.test(out)) throw new Error("cf did not revoke the sessions");
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
    // Every value is checked or generated above, so it is safe inside the SQL text.
    d1(`INSERT INTO tokens (id, author, name, digest, created_at) VALUES ('${hex(12)}', '${inst.author.replace(/'/g, "''")}', '${arg}', '${digest}', ${Date.now()})`, inst, flags);
    console.error(`Token "${arg}" created. It is shown once; store it where your Publisher reads it.`);
    console.log(token);
  } else if (cmd === "list") {
    for (const t of d1("SELECT id, name, created_at, last_used_at, revoked_at FROM tokens ORDER BY created_at DESC", inst, flags)) {
      const when = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16) : "never");
      // A name stored by an older Worker may hold control or bidi characters; the terminal never gets them.
      const name = t.name.replace(/(?![\u200c\u200d])[\p{Cc}\p{Cf}]/gu, "");
      console.log(`${t.id}  ${name.padEnd(24)} created ${when(t.created_at)}  last used ${when(t.last_used_at)}  ${t.revoked_at ? "REVOKED" : "live"}`);
    }
  } else if (cmd === "revoke") {
    if (!arg || !/^[0-9a-f]{12}$/.test(arg)) throw new Error("Give the token id (12 hex characters) from `pnpm run token list`.");
    d1(`UPDATE tokens SET revoked_at = ${Date.now()} WHERE id = '${arg}' AND revoked_at IS NULL`, inst, flags);
    console.log(`Token ${arg} revoked.`);
  } else if (cmd === "revoke-all") {
    revokeAll({
      checkAccount: () => (checkSameAccount(wranglerWho(), cf("auth", "whoami"), process.env), "Wrangler and cf use the same one"),
      revokeTokens: () => `${d1(`UPDATE tokens SET revoked_at = ${Date.now()} WHERE revoked_at IS NULL RETURNING id`, inst, flags).length} revoked`,
      rotateTicketKey: () => (putTicketKey(generatedConfig(inst)), "replaced; every open ticket has ended"),
      revokeSessions: () => revokeSessions(inst),
    }, { local: flags.local, say: (line) => console.log(line) });
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
