#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript-classic";
import { checkRevokeAllModel, checkStoreModel, type CheckResult, type RevokeBugVariant, type StoreBugVariant } from "./store-lifecycle.model.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface ConformanceFinding {
  codeFile: string;
  symbol: string;
  detectedVariant: StoreBugVariant | RevokeBugVariant;
  detail: string;
}

function extractBody(source: string, fileName: string, kind: "method" | "function" | "const", name: string): string {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  let found = "";
  const visit = (node: ts.Node) => {
    if (found) return;
    if (kind === "method" && ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found = node.getText(sf);
      return;
    }
    if (kind === "function" && ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node.getText(sf);
      return;
    }
    if (kind === "const" && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found = node.getText(sf);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

export function detectCodeDeviationsFromSource(store: string, token: string): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];

  const expireBlock = extractBody(store, "src/store.ts", "method", "expire");
  const delViewsAt = expireBlock.indexOf("DELETE FROM share_views");
  const delVersionsAt = expireBlock.indexOf("DELETE FROM versions");
  if (delViewsAt === -1 || delVersionsAt === -1 || delViewsAt > delVersionsAt) {
    findings.push({
      codeFile: "src/store.ts",
      symbol: "Store.expire",
      detectedVariant: "expire-views-after-versions",
      detail: "DELETE FROM share_views must run before DELETE FROM versions inside Store.expire().",
    });
  }

  const countViewBlock = extractBody(store, "src/store.ts", "method", "countView");
  if (!/WHERE EXISTS\s*\(\s*SELECT 1 FROM shares WHERE slug = \?1 AND \$\{live\(\)\}\s*\)/.test(countViewBlock)) {
    findings.push({
      codeFile: "src/store.ts",
      symbol: "Store.countView",
      detectedVariant: "count-view-without-live-guard",
      detail: "Store.countView() must guard its INSERT with WHERE EXISTS (SELECT 1 FROM shares WHERE slug = ?1 AND ${live()}).",
    });
  }

  const addVersionBlock = extractBody(store, "src/store.ts", "method", "addVersion");
  const updateAt = addVersionBlock.indexOf("UPDATE shares SET");
  const updatePart = updateAt === -1 ? "" : addVersionBlock.slice(updateAt);
  if (!updatePart || updatePart.includes("${live()}")) {
    findings.push({
      codeFile: "src/store.ts",
      symbol: "Store.addVersion",
      detectedVariant: "add-version-rechecks-live",
      detail: "Store.addVersion() statement 2 must follow WROTE and never re-check ${live()} after statement 1.",
    });
  }

  const reservedDecl = extractBody(store, "src/store.ts", "const", "RESERVED");
  if (!reservedDecl.includes("due_at > ${CLOCK}")) {
    findings.push({
      codeFile: "src/store.ts",
      symbol: "RESERVED",
      detectedVariant: "claim-expired-reservation",
      detail: "RESERVED must enforce due_at > ${CLOCK} so expired reservations cannot be claimed.",
    });
  }

  const emptyTrashBlock = extractBody(store, "src/store.ts", "method", "emptyTrash");
  if (!emptyTrashBlock.includes("DELETE FROM trash WHERE (body_key, CAST(due_at AS TEXT) || ':' || nonce) IN")) {
    findings.push({
      codeFile: "src/store.ts",
      symbol: "Store.emptyTrash",
      detectedVariant: emptyTrashBlock.includes("DELETE FROM trash WHERE (body_key, due_at) IN") ? "due-now-two-empty-trash-race" : "empty-trash-ignores-due-at",
      detail: "Store.emptyTrash() must delete trash rows matching (body_key, due_at, nonce).",
    });
  }

  const trashNonceDecl = extractBody(store, "src/store.ts", "const", "TRASH_NONCE");
  const dueNowBlock = extractBody(store, "src/store.ts", "method", "dueNow");
  const writesFreshNonce = trashNonceDecl.includes("randomblob")
    && (dueNowBlock.includes("${TRASH_NONCE}") || dueNowBlock.includes("randomblob"))
    && /ON CONFLICT\s*\(\s*body_key\s*\)\s*DO UPDATE SET[\s\S]*\bnonce\s*=\s*excluded\.nonce\b/.test(dueNowBlock)
    && dueNowBlock.includes("MAX(trash.due_at + 1, excluded.due_at)");
  if (!writesFreshNonce) {
    findings.push({
      codeFile: "src/store.ts",
      symbol: "Store.dueNow",
      detectedVariant: "due-now-two-empty-trash-race",
      detail: "Store.dueNow() must advance due_at on already-due conflicts and write a fresh per-write nonce on insert and ON CONFLICT DO UPDATE so concurrent and mixed-version emptyTrash() workers cannot delete a re-ledgered row.",
    });
  }

  const liveTokenDecl = extractBody(store, "src/store.ts", "const", "LIVE_TOKEN");
  const unguarded = ["createShare", "addVersion", "updateFields", "setPublic", "deleteShare", "revokeToken"]
    .filter((m) => !extractBody(store, "src/store.ts", "method", m).includes("${LIVE_TOKEN}"));
  if (!/FROM tokens WHERE id = \? AND revoked_at IS NULL/.test(liveTokenDecl) || unguarded.length > 0) {
    findings.push({
      codeFile: "src/store.ts",
      symbol: unguarded.length ? unguarded.map((m) => `Store.${m}`).join(", ") : "LIVE_TOKEN",
      detectedVariant: "write-commit-skips-token-check",
      detail: "Every token-authorized Store write must re-check ${LIVE_TOKEN} (the token unrevoked) in its liveness-deciding statement.",
    });
  }

  const notRevokedDecl = extractBody(store, "src/store.ts", "const", "NOT_REVOKED_SINCE");
  const createTokenBody = extractBody(store, "src/store.ts", "method", "createToken");
  if (!/NOT EXISTS \(SELECT 1 FROM revocations WHERE at >= \?\)/.test(notRevokedDecl)
    || !/INSERT INTO tokens \([^)]*\) SELECT [?, ]+ WHERE \$\{NOT_REVOKED_SINCE\}/.test(createTokenBody)) {
    findings.push({
      codeFile: "src/store.ts",
      symbol: "Store.createToken",
      detectedVariant: "mint-skips-revocation-marker",
      detail: "Store.createToken must insert only WHERE ${NOT_REVOKED_SINCE}: no revoke-all recorded at or after the sign-in's issue time.",
    });
  }

  const statements = extractBody(token, "scripts/token.mjs", "function", "revokeTokenStatements");
  const markerStmtAt = statements.indexOf("INSERT INTO revocations");
  const updateStmtAt = statements.indexOf("UPDATE tokens SET revoked_at");
  const sentMarkerAt = token.indexOf("d1(marker, ");
  const sentUpdateAt = token.indexOf("${update}", sentMarkerAt);
  if (markerStmtAt === -1 || updateStmtAt === -1 || markerStmtAt > updateStmtAt || sentMarkerAt === -1 || sentUpdateAt === -1) {
    findings.push({
      codeFile: "scripts/token.mjs",
      symbol: "revokeTokenStatements",
      detectedVariant: "revoke-all-marker-after-tokens",
      detail: "revoke-all's Tokens step must record the revocation time before it revokes the tokens.",
    });
  }

  const revokeBlock = extractBody(token, "scripts/token.mjs", "function", "revokeAll");
  const remoteAt = revokeBlock.indexOf(": [[");
  const remoteSteps = remoteAt === -1 ? "" : revokeBlock.slice(remoteAt);
  const sessionsAt = remoteSteps.indexOf('"Access sign-ins"');
  const tokensAt = remoteSteps.indexOf('"Tokens"');
  const ticketAt = remoteSteps.indexOf('"Ticket key"');
  if (sessionsAt === -1 || tokensAt === -1 || ticketAt === -1 || !(sessionsAt < tokensAt && tokensAt < ticketAt)) {
    findings.push({
      codeFile: "scripts/token.mjs",
      symbol: "revokeAll",
      detectedVariant: "revoke-all-sessions-last",
      detail: "revokeAll() must revoke Access sign-ins before Tokens and Ticket key.",
    });
  }

  return findings;
}

export function detectCodeDeviations(root = ROOT): ConformanceFinding[] {
  const store = readFileSync(join(root, "src/store.ts"), "utf8");
  const token = readFileSync(join(root, "scripts/token.mjs"), "utf8");
  return detectCodeDeviationsFromSource(store, token);
}

export function formatResult(r: CheckResult): string {
  if (r.ok) {
    return `PASS  ${r.model} (${r.variant}): ${r.statesExplored} reachable states, ${r.transitionsExplored} transitions, 0 invariant violations.`;
  }
  const v = r.violation!;
  const steps = v.trace.map((step, i) => `  ${i + 1}. ${step}`).join("\n");
  return `FAIL  ${r.model} (${r.variant}) violated ${v.invariant} after ${r.statesExplored} states:\n  Harm: ${v.reason}\n  Shortest counterexample:\n${steps}`;
}

export const HISTORICAL_STORE_BUGS: readonly { bug: StoreBugVariant; expectedInvariant: string; source: string }[] = [
  { bug: "expire-views-after-versions", expectedInvariant: "EXPIRE_BATCH_ISOLATION", source: "commit b46fab1 (v0.1.7)" },
  { bug: "count-view-without-live-guard", expectedInvariant: "NO_ORPHAN_VIEWS_AFTER_PURGE_OR_ERASE", source: "commit b46fab1 (v0.1.7)" },
  { bug: "add-version-rechecks-live", expectedInvariant: "SHARE_VERSION_CONSISTENCY", source: "plan 008 / mutation #187" },
  { bug: "claim-expired-reservation", expectedInvariant: "NO_DANGLING_VERSION_BODY", source: "mutation #75" },
  { bug: "empty-trash-ignores-due-at", expectedInvariant: "NO_LOST_RELEDGERED_TRASH", source: "Store.emptyTrash race" },
  { bug: "due-now-same-ms-race", expectedInvariant: "NO_LOST_RELEDGERED_TRASH", source: "found by model checker (Store.dueNow same-ms conflict)" },
  { bug: "due-now-two-empty-trash-race", expectedInvariant: "NO_LOST_RELEDGERED_TRASH", source: "v0.1.23 audit STORE-01 (two concurrent emptyTrash workers racing dueNow)" },
];

export const HISTORICAL_REVOKE_BUGS: readonly { bug: RevokeBugVariant; expectedInvariant: string; source: string }[] = [
  { bug: "revoke-all-sessions-last", expectedInvariant: "CONTAINMENT_NO_POST_REVOKE_CREDENTIAL", source: "commit 17a60d6 (v0.1.18 F-03)" },
  { bug: "write-commit-skips-token-check", expectedInvariant: "CONTAINMENT_NO_POST_REVOKE_WRITE", source: "2026-11-25 audit H2-1 (write in flight across revocation)" },
  { bug: "mint-skips-revocation-marker", expectedInvariant: "CONTAINMENT_NO_POST_REVOKE_CREDENTIAL", source: "2026-11-27 audit P-15 (token creation in flight across revoke-all)" },
  { bug: "revoke-all-marker-after-tokens", expectedInvariant: "CONTAINMENT_NO_POST_REVOKE_CREDENTIAL", source: "2026-11-27 audit P-15 (revocation time recorded after the token sweep)" },
];

const REVOKE_VARIANTS = new Set<string>(HISTORICAL_REVOKE_BUGS.map((b) => b.bug));
const isRevokeVariant = (v: StoreBugVariant | RevokeBugVariant): v is RevokeBugVariant => REVOKE_VARIANTS.has(v);

export function runFormalVerification(root = ROOT, { replayBugs = false } = {}) {
  const deviations = detectCodeDeviations(root);
  const results: CheckResult[] = [];
  if (deviations.length > 0) {
    for (const d of deviations) {
      if (isRevokeVariant(d.detectedVariant)) {
        results.push(checkRevokeAllModel(d.detectedVariant));
      } else {
        results.push(checkStoreModel(d.detectedVariant));
      }
    }
    return { ok: false, deviations, results, replayResults: [] as CheckResult[] };
  }

  results.push(checkStoreModel("none"));
  results.push(checkRevokeAllModel("none"));
  const replayResults: CheckResult[] = [];
  if (replayBugs) {
    for (const entry of HISTORICAL_STORE_BUGS) replayResults.push(checkStoreModel(entry.bug));
    for (const entry of HISTORICAL_REVOKE_BUGS) replayResults.push(checkRevokeAllModel(entry.bug));
  }
  const ok = results.every((r) => r.ok) && replayResults.every((r) => !r.ok);
  return { ok, deviations, results, replayResults };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const replayBugs = process.argv.includes("--replay-bugs");
  const { ok, deviations, results, replayResults } = runFormalVerification(ROOT, { replayBugs });
  if (deviations.length) {
    console.error("Code-to-model conformance failed:");
    for (const d of deviations) console.error(`  - ${d.codeFile} (${d.symbol}): ${d.detail}`);
  }
  for (const r of results) console.log(formatResult(r));
  if (replayBugs) {
    console.log("\nHistorical bug replays (every replay MUST FAIL on its invariant):");
    for (const r of replayResults) {
      const caught = !r.ok;
      console.log(`${caught ? "CAUGHT" : "MISSED"} ${r.model}/${r.variant} -> ${r.violation?.invariant ?? "no violation"} (${r.violation?.trace.length ?? 0} steps)`);
    }
  }
  process.exit(ok ? 0 : 1);
}
