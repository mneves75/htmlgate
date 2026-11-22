#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript-classic";
import { checkVersionSync } from "./sync-version.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(?:ts|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out.sort();
}

function lineOf(sf, pos) {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function stringLiteral(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function objectProperty(obj, name) {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return undefined;
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined;
      if (key === name) return prop.initializer;
    } else if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === name) {
      return prop.name;
    }
  }
  return undefined;
}

function isInsideFunction(node, name) {
  let cur = node.parent;
  while (cur) {
    if ((ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur) || ts.isMethodDeclaration(cur)) && cur.name && ts.isIdentifier(cur.name) && cur.name.text === name) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

function hasObjectSpread(obj) {
  return ts.isObjectLiteralExpression(obj) && obj.properties.some((p) => ts.isSpreadAssignment(p));
}

export function lintSource(relPath, content) {
  const findings = [];
  const report = (rule, line, message) => findings.push({ rule, file: relPath, line, message });
  const sf = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true, relPath.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const inWorkerSrc = relPath.startsWith("src/");
  const inSiteSrc = relPath.startsWith("site/src/");
  const inCliSrc = relPath.startsWith("packages/cli/src/");
  const inScripts = relPath.startsWith("scripts/");
  const isStrictTs = inWorkerSrc || inSiteSrc || inCliSrc;

  // Rule 8b: @ts-ignore / @ts-expect-error suppressions in first-party TS source
  if (isStrictTs) {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (/@ts-(?:ignore|expect-error)\b/.test(lines[i])) {
        report("no-any-or-ts-suppression", i + 1, "Do not suppress TypeScript errors with @ts-ignore or @ts-expect-error in source. Fix the types instead.");
      }
    }
  }

  const visit = (node) => {
    // Rule 1: no-raw-response — every Instance response must go through src/http.ts so BASE headers cannot be skipped (commit d6794f6).
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Response") {
      if (inWorkerSrc && relPath !== "src/http.ts") {
        report("no-raw-response", lineOf(sf, node.getStart(sf)), "Do not call `new Response(...)` outside src/http.ts. Use text(), json(), fail(), redirect(), noContent(), stream(), bytes(), or copyResponse() from ./http so BASE hardening headers are never dropped.");
      }
      if (inSiteSrc && !isInsideFunction(node, "withHeaders") && !isInsideFunction(node, "redirect") && !isInsideFunction(node, "fetch")) {
        report("no-raw-response", lineOf(sf, node.getStart(sf)), "Wrap every landing Response in withHeaders() so CSP and HSTS headers are never dropped.");
      }
    }

    // Rule 2: no-unsafe-fetch — fetch() and smoke's paced() must set redirect: "manual" (never follow redirects with Bearer tokens) and bound waits with a signal.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      if (callee === "fetch" && (inWorkerSrc || inCliSrc || (inScripts && !relPath.startsWith("scripts/perf/")))) {
        const init = node.arguments[1];
        const isSendWrapper = relPath === "scripts/bench.ts" && isInsideFunction(node, "send");
        const isPacedWrapper = relPath === "scripts/smoke.mjs" && isInsideFunction(node, "paced");
        if (!isSendWrapper) {
          if (!init || !ts.isObjectLiteralExpression(init)) {
            report("no-unsafe-fetch", lineOf(sf, node.getStart(sf)), 'Pass an options object with `redirect: "manual"` and a timeout `signal` to fetch().');
          } else {
            const redir = objectProperty(init, "redirect");
            const sig = objectProperty(init, "signal");
            if (!isPacedWrapper && stringLiteral(redir) !== "manual") {
              report("no-unsafe-fetch", lineOf(sf, node.getStart(sf)), 'Set `redirect: "manual"` on fetch() so credentials and tokens are never forwarded across redirects.');
            }
            if (!sig && !hasObjectSpread(init)) {
              report("no-unsafe-fetch", lineOf(sf, node.getStart(sf)), "Set a deadline `signal` (e.g. `AbortSignal.timeout(...)`) on fetch() so a stalled endpoint cannot hang indefinitely.");
            }
          }
        }
      }
      if ((callee === "paced" && relPath === "scripts/smoke.mjs") || (callee === "send" && relPath === "scripts/bench.ts")) {
        const init = node.arguments[1];
        if (!init || !ts.isObjectLiteralExpression(init) || stringLiteral(objectProperty(init, "redirect")) !== "manual") {
          report("no-unsafe-fetch", lineOf(sf, node.getStart(sf)), `Pass \`redirect: "manual"\` to ${callee}() so authenticated or probe requests never silently follow redirects.`);
        }
      }
    }

    // Rule 3 & 4: cf CLI pagination and --force safety in scripts/
    if (inScripts && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === "cf" || node.expression.text === "cfImpl")) {
      const lits = node.arguments.map(stringLiteral);
      const isWorkersList = lits[0] === "workers" && lits[1] === "list";
      const isAppsList = lits[0] === "zero-trust" && lits[1] === "access" && lits[2] === "applications" && lits[3] === "list";
      const isBucketsList = lits[0] === "r2" && lits[1] === "buckets" && lits[2] === "list";
      if (isWorkersList && !(relPath === "scripts/setup.mjs" && isInsideFunction(node, "listWorkers"))) {
        report("no-unpaginated-cf-list", lineOf(sf, node.getStart(sf)), "Use listWorkers(cf) from scripts/setup.mjs instead of calling cf('workers', 'list', ...) directly; cf pages silently.");
      }
      if (isAppsList && !(relPath === "scripts/setup.mjs" && isInsideFunction(node, "listApplications"))) {
        report("no-unpaginated-cf-list", lineOf(sf, node.getStart(sf)), "Use listApplications(cf) from scripts/setup.mjs instead of calling cf('zero-trust', 'access', 'applications', 'list', ...) directly; cf pages silently.");
      }
      if (isBucketsList && !(relPath === "scripts/setup.mjs" && isInsideFunction(node, "listBuckets"))) {
        report("no-unpaginated-cf-list", lineOf(sf, node.getStart(sf)), "Use listBuckets() in scripts/setup.mjs instead of calling cf('r2', 'buckets', 'list', ...) directly; cf pages silently.");
      }
      if ((lits.includes("delete") || lits.includes("revoke-tokens")) && !lits.includes("--force")) {
        report("no-cf-destructive-without-force", lineOf(sf, node.getStart(sf)), 'Pass `"--force"` to `cf ... delete` and `cf ... revoke-tokens`; without it, cf prints "Aborted." and still exits 0.');
      }
    }

    // Rule 5: no-brew-info-installed — `brew info --installed` dumps every formula on the host (>1 MB) and overflows spawnSync (commit a2a2ffc).
    if (inScripts && ts.isArrayLiteralExpression(node)) {
      const lits = node.elements.map(stringLiteral);
      if (lits[0] === "info" && lits.includes("--installed")) {
        report("no-brew-info-installed", lineOf(sf, node.getStart(sf)), 'Do not pass `"--installed"` to `brew info`; pass the single formula name so spawnSync does not overflow its 1 MB buffer.');
      }
    }

    // Rule 6: no-unvalidated-env-number — raw Number(process.env.X) or Number(arg(...)) turns typos into NaN and silently disables comparisons (commit c66b143).
    if ((inScripts || inWorkerSrc || inCliSrc) && ts.isVariableDeclaration(node) && node.initializer) {
      const init = node.initializer;
      const checkRawNumberCall = (expr) => {
        if (!ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression) || expr.expression.text !== "Number") return false;
        const firstArg = expr.arguments[0];
        if (!firstArg) return false;
        const txt = firstArg.getText(sf);
        return txt.includes("process.env.") || /\barg\s*\(/.test(txt);
      };
      const targetExpr = ts.isConditionalExpression(init) ? (checkRawNumberCall(init.whenTrue) ? init.whenTrue : checkRawNumberCall(init.whenFalse) ? init.whenFalse : null) : (checkRawNumberCall(init) ? init : null);
      if (targetExpr) {
        const parentText = node.parent?.parent?.getText(sf) ?? "";
        if (!/isFinite|isSafeInteger/.test(parentText)) {
          report("no-unvalidated-env-number", lineOf(sf, targetExpr.getStart(sf)), "Do not coerce process.env or CLI arg with raw Number(...); validate with Number.isFinite() (e.g. parseFinite / parseNonNegative) so a typo cannot become NaN.");
        }
      }
    }

    // Rule 7: no-access-identity-bypass — identity comes only from verified Cf-Access-Jwt-Assertion in src/access.ts (issue #18).
    if (inWorkerSrc) {
      if (ts.isPropertyAccessExpression(node) && node.name.text === "access" && ts.isIdentifier(node.expression) && node.expression.text === "ctx") {
        report("no-access-identity-bypass", lineOf(sf, node.getStart(sf)), "Never read identity from ctx.access. Verify Cf-Access-Jwt-Assertion through person() in src/access.ts.");
      }
      const lit = stringLiteral(node)?.toLowerCase();
      if (lit === "cf-access-authenticated-user-email" || lit === "cf_authorization") {
        report("no-access-identity-bypass", lineOf(sf, node.getStart(sf)), `Never trust "${stringLiteral(node)}" for identity. Verify Cf-Access-Jwt-Assertion through person() in src/access.ts.`);
      }
    }

    // Rule 8a: no-any-or-ts-suppression — no `any` in first-party TS source (AGENTS.md).
    if (isStrictTs && node.kind === ts.SyntaxKind.AnyKeyword) {
      report("no-any-or-ts-suppression", lineOf(sf, node.getStart(sf)), "Do not use `any` in source code. Use `unknown` and narrow it.");
    }

    // Rule 9: no-proto-pollutable-dict — queryFields and parseMetadata must use Object.create(null) so literal keys like `__proto__` are preserved (mutations #149, #215, #216).
    if ((relPath === "src/api.ts" && isInsideFunction(node, "queryFields")) || (relPath === "packages/cli/src/files.ts" && isInsideFunction(node, "parseMetadata"))) {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectLiteralExpression(node.initializer) && node.initializer.properties.length === 0) {
        report("no-proto-pollutable-dict", lineOf(sf, node.initializer.getStart(sf)), "Initialize user-keyed dictionaries in queryFields/parseMetadata with `Object.create(null)`, never `{}`, so literal keys like `__proto__` are preserved.");
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

export function lintRepo(root = ROOT) {
  const dirs = ["src", "site/src", "packages/cli/src", "scripts"];
  const findings = [];
  for (const dir of dirs) {
    for (const full of walk(join(root, dir))) {
      const rel = relative(root, full).replace(/\\/g, "/");
      findings.push(...lintSource(rel, readFileSync(full, "utf8")));
    }
  }
  const { mismatches } = checkVersionSync(root);
  for (const m of mismatches) {
    findings.push({ rule: "version-in-sync", file: "package.json", line: 1, message: `${m}. Fix: run \`pnpm run version:sync && pnpm run cli:formula\`.` });
  }
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = lintRepo(ROOT);
  if (findings.length) {
    for (const f of findings) console.error(`${f.file}:${f.line} [${f.rule}] ${f.message}`);
    console.error(`\n${findings.length} lint error(s) found.`);
    process.exit(1);
  }
  console.log("Lint passed: 0 violations across src/, site/src/, packages/cli/src/, scripts/ and version sync.");
}
