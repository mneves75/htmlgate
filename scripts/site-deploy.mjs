#!/usr/bin/env node
// Deploys the public landing (site/), which is not an Instance and has no Access application.
// A preview is its own Worker on workers.dev only, so it can never change the live site. Live attaches
// htmlgate.com and www together on every deploy: Wrangler replaces the listed Custom Domains, so a
// deploy that named only one would detach the other.
//
// Usage: pnpm run site:deploy --preview | --live
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cf, checkCleanTree, checkDomain, checkSameAccount, listWorkers, sh, wranglerWho } from "./setup.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = join(ROOT, "node_modules/.bin/wrangler");
const SITE = "https://htmlgate.com";
const APP = "https://app.htmlgate.com/";
const DOMAINS = ["htmlgate.com", "www.htmlgate.com"];

export function deployPlan(argv) {
  if (argv.length !== 1 || (argv[0] !== "--preview" && argv[0] !== "--live")) throw new Error("Say where to deploy: --preview or --live.");
  const live = argv[0] === "--live";
  const name = live ? "htmlgate-site" : "htmlgate-site-preview";
  const domains = live ? DOMAINS : [];
  return { name, domains, args: ["deploy", "-c", "site/wrangler.jsonc", "--name", name, ...domains.flatMap((d) => ["--domain", d])] };
}

/**
 * Refuses to deploy over a Worker that is not this landing's: an Instance (it has an Access application
 * named after it), or, for a preview, a Worker that serves a domain, since a preview must never change one.
 */
export function checkTarget(plan, cf) {
  const apps = cf("zero-trust", "access", "applications", "list", "--per-page", "1000");
  if (!Array.isArray(apps)) throw new Error("cf returned no Access application list.");
  if (apps.some((a) => a.name === `htmlgate: ${plan.name}`)) throw new Error(`The Worker ${plan.name} is an htmlgate Instance. The landing will not deploy over it.`);
  const worker = listWorkers(cf).find((w) => w.name === plan.name);
  const domains = (worker?.references?.domains ?? []).map((d) => d.hostname);
  if (plan.domains.length === 0 && domains.length > 0) {
    throw new Error(`The preview Worker ${plan.name} serves the Custom Domain ${domains.join(", ")}. A preview must never change a domain.`);
  }
}

/** The landing's sign-in links lead to app.htmlgate.com: it must answer behind its Access sign-in before the landing goes live. */
export async function checkAppGated(fetchImpl = fetch) {
  let status = 0;
  let to = "";
  try {
    const r = await fetchImpl(APP, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    status = r.status;
    to = r.headers.get("location") ?? "";
  } catch (e) {
    throw new Error(`${APP} does not answer (${e.message}). Set up the production Instance there first.`);
  }
  const host = URL.canParse(to) ? new URL(to).hostname : "";
  if (status !== 302 || !host.endsWith(".cloudflareaccess.com")) {
    throw new Error(`${APP} answered ${status}${to ? ` to ${to}` : ""}, not its Access sign-in. Set up the production Instance there first.`);
  }
}

/** Polls until `check` passes on a response from `url`: a new Custom Domain needs its DNS record and certificate first. */
async function expectLive(url, check, what) {
  const deadline = Date.now() + 180_000;
  let last = "no answer";
  for (;;) {
    try {
      const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      last = `${r.status} ${r.headers.get("location") ?? ""}`.trim();
      if (check(r)) return console.log(`  ok: ${what}`);
    } catch (e) {
      last = e.message;
    }
    if (Date.now() > deadline) throw new Error(`${what}: ${url} answered ${last}. DNS and certificates can take a while; run it again.`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

async function main() {
  const plan = deployPlan(process.argv.slice(2));
  const step = (s) => console.log(`- ${s}`);

  step("checking that the source is committed");
  checkCleanTree();
  step("checking the Cloudflare logins");
  checkSameAccount(wranglerWho(), cf("auth", "whoami"), process.env);
  step(`checking that ${plan.name} is the landing's own Worker, or does not exist yet`);
  checkTarget(plan, cf);
  if (plan.domains.length > 0) {
    step(`checking that ${APP} answers behind its sign-in`);
    await checkAppGated();
  }
  for (const domain of plan.domains) {
    step(`checking that ${domain} is free or already the landing's`);
    checkDomain({ name: plan.name, domain }, cf);
  }

  step(`deploying ${plan.name}`);
  const out = sh(WRANGLER, plan.args);

  step("checking what answers");
  const csp = (r) => (r.headers.get("content-security-policy") ?? "").startsWith("default-src 'none'");
  if (plan.domains.length === 0) {
    const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(out)?.[0];
    if (!url) throw new Error("Deployed, but Wrangler printed no workers.dev URL.");
    await expectLive(`${url}/`, (r) => r.status === 200 && csp(r) && r.headers.get("x-robots-tag") === "noindex", "the preview answers, not indexable");
    console.log(`\nPreview ready: ${url}/ and ${url}/en/`);
  } else {
    await expectLive(`${SITE}/`, (r) => r.status === 200 && csp(r) && !r.headers.has("x-robots-tag"), "htmlgate.com answers, indexable");
    await expectLive("https://www.htmlgate.com/en/", (r) => r.status === 301 && r.headers.get("location") === `${SITE}/en/`, "www goes to htmlgate.com");
    await expectLive(`${SITE}/app`, (r) => r.status === 302 && r.headers.get("location") === APP, "/app goes to app.htmlgate.com");
    console.log(`\nLanding live: ${SITE}/`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`site deploy failed: ${e.message}`);
    process.exit(1);
  });
}
