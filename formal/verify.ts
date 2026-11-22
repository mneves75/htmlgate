#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRevokeAllModel, checkStoreModel, type CheckResult, type RevokeBugVariant, type StoreBugVariant } from "./store-lifecycle.model.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface ConformanceFinding {
  codeFile: string;
  symbol: string;
  detectedVariant: StoreBugVariant | RevokeBugVariant;
  detail: string;
}

export function detectCodeDeviationsFromSource(store: string, token: string): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];

  const expireBlock = store.slice(store.indexOf("async expire("), store.indexOf("async useToken("));
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

  const countViewBlock = store.slice(store.indexOf("async countView("), store.indexOf("async viewsBySlug("));
  if (!/WHERE EXISTS\s*\(\s*SELECT 1 FROM shares WHERE slug = \?1 AND \$\{live\(\)\}\s*\)/.test(countViewBlock)) {
    findings.push({
      codeFile: "src/store.ts",
      symbol: "Store.countView",
      detectedVariant: "count-view-without-live-guard",
      detail: "Store.countView() must guard its INSERT with WHERE EXISTS (SELECT 1 FROM shares WHERE slug = ?1 AND ${live()}).",
    });
  }

  const addVersionBlock = store.slice(store.indexOf("async addVersion("), store.indexOf("async updateFields("));
  const updatePart = addVersionBlock.slice(addVersionBlock.indexOf("UPDATE shares SET"));
  if (updatePart.includes("${live()}")) {
    findings.push({
      codeFile: "src/store.ts",
      symbol: "Store.addVersion",
      detectedVariant: "add-version-rechecks-live",
      detail: "Store.addVersion() statement 2 must follow WROTE and never re-check ${live()} after statement 1.",
    });
  }

  const reservedLine = store.match(/const RESERVED = .*?;/)?.[0] ?? "";
  if (!reservedLine.includes("due_at > ${CLOCK}")) {
    findings.push({
      codeFile: "src/store.ts",
      symbol: "RESERVED",
      detectedVariant: "claim-expired-reservation",
      detail: "RESERVED must enforce due_at > ${CLOCK} so expired reservations cannot be claimed.",
    });
  }

  const emptyTrashBlock = store.slice(store.indexOf("async emptyTrash("), store.indexOf("async body("));
  if (!emptyTrashBlock.includes("DELETE FROM trash WHERE (body_key, due_at) IN")) {
    findings.push({
      codeFile: "src/store.ts",
      symbol: "Store.emptyTrash",
      detectedVariant: "empty-trash-ignores-due-at",
      detail: "Store.emptyTrash() must delete trash rows matching both (body_key, due_at).",
    });
  }

  const dueNowBlock = store.slice(store.indexOf("private async dueNow("), store.indexOf("private async commit("));
  if (!/ON CONFLICT\s*\(\s*body_key\s*\)\s*DO UPDATE SET\s+due_at\s*=\s*CASE\s+WHEN\s+excluded\.due_at\s*=\s*trash\.due_at\s+THEN\s+excluded\.due_at\s*\+\s*1\s+ELSE\s+excluded\.due_at\s+END/.test(dueNowBlock)) {
    findings.push({
      codeFile: "src/store.ts",
      symbol: "Store.dueNow",
      detectedVariant: "due-now-same-ms-race",
      detail: "Store.dueNow() must advance due_at by 1ms on conflict when excluded.due_at = trash.due_at so an in-flight emptyTrash() cannot delete the re-ledgered row.",
    });
  }

  const revokeBlock = token.slice(token.indexOf("export function revokeAll("), token.indexOf("function revocationTarget("));
  const remoteSteps = revokeBlock.slice(revokeBlock.indexOf(": [["));
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
];

export const HISTORICAL_REVOKE_BUGS: readonly { bug: RevokeBugVariant; expectedInvariant: string; source: string }[] = [
  { bug: "revoke-all-sessions-last", expectedInvariant: "CONTAINMENT_NO_POST_REVOKE_CREDENTIAL", source: "commit 17a60d6 (v0.1.18 F-03)" },
];

export function runFormalVerification(root = ROOT, { replayBugs = false } = {}) {
  const deviations = detectCodeDeviations(root);
  const results: CheckResult[] = [];
  if (deviations.length > 0) {
    for (const d of deviations) {
      if (d.detectedVariant === "revoke-all-sessions-last") {
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
