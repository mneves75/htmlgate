#!/usr/bin/env node
// Controls for the security checks: plant each violation, prove the named test file goes red,
// then restore the source. A check that stays green with its protection removed proves nothing.
// Usage: pnpm run mutate [--check] [--only <text>]   (--check validates anchors without planting;
// --only runs the mutations whose name contains the text, for iterating;
// the full run is the gate)
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyMutation } from "./mutation-reporter.mjs";

const MUTATIONS = [
  ["shares lose the sandbox header", "src/index.ts", "const RAW_HEADERS = {\n  \"content-security-policy\": `sandbox ${SHARE_SANDBOX}; frame-ancestors 'self'`,", "const RAW_HEADERS = {\n  \"content-security-policy\": `frame-ancestors 'self'`,", "test/viewer.test.ts"],
  ["the sandbox allows same-origin", "src/pages.ts", '"allow-scripts allow-popups allow-popups-to-escape-sandbox"', '"allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"', "test/viewer.test.ts"],
  ["responses become cacheable", "src/http.ts", '"cache-control": "no-store"', '"cache-control": "public, max-age=60"', "test/viewer.test.ts"],
  ["the JWT signature is not checked", "src/access.ts", "const { payload } = await jwtVerify(token, keys(cfg.teamUrl), {", "const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))); void ({", "test/viewer.test.ts"],
  ["the audience is not checked", "src/access.ts", "audience: cfg.aud,", "", "test/viewer.test.ts"],
  ["the Allowlist is not checked", "src/access.ts", "return cfg.allowlist.has(email) ? email : null;", "return email || null;", "test/viewer.test.ts"],
  ["a request without Fetch Metadata skips the Origin check", "src/index.ts", 'return req.headers.get("origin") === url.origin;', "return true;", "test/viewer.test.ts"],
  ["public paths serve Gated Shares", "src/index.ts", "serveShare(env, cfg, url, \"p\", view[2]!, !!view[3], null)", "serveShare(env, cfg, url, \"s\", view[2]!, !!view[3], null)", "test/viewer.test.ts"],
  ["paths match loosely", "src/index.ts", "const VIEW = /^\\/(s|p)\\/([A-Za-z0-9]{12})(\\/raw)?$/;", "const VIEW = /^\\/+(s|p)\\/([A-Za-z0-9]{12})(\\/raw)?\\/?/i;", "test/viewer.test.ts"],
  ["a deleted Share's body stays viewable", "src/store.ts", "AND ${live(\"d.\")} ${publicOnly ? \"AND d.public = 1\" : \"\"}`)\n      .bind(n, slug, author)", "${publicOnly ? \"AND d.public = 1\" : \"\"}`)\n      .bind(n, slug, author)", "test/viewer.test.ts"],
  ["a deleted Share's viewer page stays viewable", "src/store.ts", "AND ${live(\"d.\")} ${publicOnly ? \"AND d.public = 1\" : \"\"} ORDER BY", "${publicOnly ? \"AND d.public = 1\" : \"\"} ORDER BY", "test/viewer.test.ts"],
  ["a Gated Share's body is served on /p/", "src/store.ts", "${live(\"d.\")} ${publicOnly ? \"AND d.public = 1\" : \"\"}`)\n      .bind(n, slug, author)", "${live(\"d.\")} ${publicOnly ? \"\" : \"\"}`)\n      .bind(n, slug, author)", "test/viewer.test.ts"],
  ["a Gated Share's viewer page is served on /p/", "src/store.ts", '${publicOnly ? "AND d.public = 1" : ""} ORDER BY', '${publicOnly ? "" : ""} ORDER BY', "test/viewer.test.ts"],
  ["a token can mint tokens", "src/api.ts", 'if (b === undefined && method === "GET") {', 'if (b === undefined && method === "POST") { return json(201, { token: "hg_" }); }\n      if (b === undefined && method === "GET") {', "test/api.test.ts"],
  ["revoked tokens keep working", "src/store.ts", "WHERE digest = ? AND revoked_at IS NULL", "WHERE digest = ?", "test/api.test.ts"],
  ["a Viewer reaches the token page", "src/index.ts", "if (!isAuthor) return lost();", "", "test/viewer.test.ts"],
  ["a Viewer's home lists Shares", "src/index.ts", "isAuthor ? await store.recentShares(cfg.author, HOME_SHARES) : null", "await store.recentShares(cfg.author, HOME_SHARES)", "test/home.test.ts"],
  ["the home lists deleted Shares", "src/store.ts", " AND ${live(\"d.\")} ORDER BY d.updated_at DESC", " ORDER BY d.updated_at DESC", "test/home.test.ts"],
  ["the home lists another Author's Shares", "src/store.ts", "WHERE d.author = ?1 AND ", "WHERE ", "test/home.test.ts"],
  ["the home counts another Author's Shares", "src/store.ts", "(SELECT COUNT(*) FROM shares WHERE author = ?1 AND ${live()}) AS total", "(SELECT COUNT(*) FROM shares WHERE ${live()}) AS total", "test/home.test.ts"],
  ["a Share title on the home is not escaped", "src/pages.ts", '<a href="/s/${d.slug}">${escapeHtml(d.title)}</a>', '<a href="/s/${d.slug}">${d.title}</a>', "test/home.test.ts"],
  ["a Publisher name on the home is not escaped", "src/pages.ts", "${escapeHtml(d.changed_by_name)}", "${d.changed_by_name}", "test/home.test.ts"],
  ["a cross-site request passes the Fetch Metadata check", "src/index.ts", 'if (site !== null) return site === "same-origin";', "if (site !== null) return true;", "test/browser.test.ts"],
  ["raw Shares send a referrer", "src/index.ts", "  // A Share's links and requests never tell other sites which Share they came from.\n  \"referrer-policy\": \"no-referrer\",\n", "  // A Share's links and requests never tell other sites which Share they came from.\n", "test/viewer.test.ts"],
  ["raw Shares lose Cross-Origin-Resource-Policy", "src/index.ts", '"cross-origin-resource-policy": "same-origin",', "", "test/viewer.test.ts"],
  ["responses lose nosniff", "src/http.ts", '"x-content-type-options": "nosniff",', "", "test/viewer.test.ts"],
  ["plain http is served", "src/index.ts", "  const insecure = cleartext(req, url);\n  if (insecure) return insecure;\n", "", "test/transport.test.ts"],
  ["an API request over plain http is redirected, not refused", "src/index.ts", 'if (url.pathname === "/api" || url.pathname.startsWith("/api/") || (req.method !== "GET" && req.method !== "HEAD")) {', "if (false) {", "test/transport.test.ts"],
  ["a change over plain http is redirected, not refused", "src/index.ts", ' || (req.method !== "GET" && req.method !== "HEAD")) {', ") {", "test/transport.test.ts"],
  ["bare /api over plain http is redirected, not refused", "src/index.ts", 'if (url.pathname === "/api" || url.pathname.startsWith("/api/")', 'if (url.pathname.startsWith("/api/")', "test/transport.test.ts"],
  ["the https redirect keeps a plain http port", "src/index.ts", '  secure.port = "";\n', "", "test/transport.test.ts"],
  ["a hostname that starts like loopback passes as loopback", "src/index.ts", "LOOPBACK.has(url.hostname)", "[...LOOPBACK].some((h) => url.hostname.startsWith(h))", "test/transport.test.ts"],
  ["responses lose HSTS", "src/http.ts", '"strict-transport-security": "max-age=31536000",', "", "test/transport.test.ts"],
  ["the project config may be a FIFO", "packages/cli/src/config.ts", '    if (!(await fh.stat()).isFile()) throw new CliError("unsafe_path", `${path} is not a regular file.`);\n', "", "test/cli-safety.test.ts"],
  ["the project config has no size cap", "packages/cli/src/config.ts", "      if (n > MAX_CONFIG_BYTES) throw new CliError(", "      if (false) throw new CliError(", "test/cli-safety.test.ts"],
  ["the project config is parsed with a backtracking pattern", "packages/cli/src/config.ts", String.raw`  for (const line of text.split(/\r?\n/)) {
    const m = API_URL.exec(line);
    if (m) return m[1] || m[2] || null;
  }
  return null;`, String.raw`  const m = /^\s*api_url\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/m.exec(text);
  return m?.[1] || m?.[2] || null;`, "test/cli-config.test.ts"],
  ["the Access cookie goes with cross-site requests", "scripts/setup.mjs", 'same_site_cookie_attribute: "lax",', "", "test/operator.test.ts"],
  ["the Access cookie is readable by scripts", "scripts/setup.mjs", "http_only_cookie_attribute: true,", "http_only_cookie_attribute: false,", "test/operator.test.ts"],
  ["smoke sends its requests back to back", "scripts/smoke.mjs", "  if (wait > 0) await new Promise((r) => setTimeout(r, wait));\n", "", "test/reviewer-release-tools.test.ts"],
  ["bench --live loads pages back to back", "scripts/bench.ts", "    await pace(2);\n", "", "test/reviewer-release-tools.test.ts"],
  ["bench --live sends its API requests back to back", "scripts/bench.ts", "  await pace(1);\n  return fetch(url, init);", "  return fetch(url, init);", "test/reviewer-release-tools.test.ts"],
  ["smoke accepts an Instance that answers plain http", "scripts/smoke.mjs", 'must(upgraded || (p === "/api/shares" && r.status === 403)', "must(true", "test/reviewer-release-tools.test.ts"],
  ["the not-found page is not sandboxed", "src/pages.ts", "</main>`, { sandbox: true });", "</main>`);", "test/viewer.test.ts"],
  ["a token of another Author is accepted", "src/api.ts", 'if (token.author !== cfg.author) return fail(401, "unauthorized", "This token belongs to no Author on this Instance.");', "", "test/operator.test.ts"],
  ["pruned bodies stay in R2", "src/store.ts", "await this.bodies.delete(rows.map((r) => r.body_key));", "", "test/storage.test.ts"],
  ["publishing can carry the gate field", "src/api.ts", 'if (key === "public") throw new HttpError(400, "invalid_arg", "Publishing never changes the gate. Use POST /api/shares/:slug/visibility.");', 'if (key === "public") continue;', "test/api.test.ts"],
  ["the size cap counts characters", "src/api.ts", "const size = new TextEncoder().encode(body.html).length;", "const size = body.html.length;", "test/api.test.ts"],
  ["the Version window is not enforced", "src/store.ts", "AND n <= (SELECT latest_version FROM shares WHERE slug = ?) - ${KEEP_VERSIONS}", "AND n <= (SELECT latest_version FROM shares WHERE slug = ?) - 1000", "test/api.test.ts"],
  ["missing settings fail open", "src/config.ts", "if (!teamUrl || !TEAM_URL.test(teamUrl) || !aud || !author || !EMAIL.test(author)) return null;", "", "test/limits.test.ts"],
  ["the team URL may be plain http anywhere", "src/config.ts", "const TEAM_URL = /^(https:\\/\\/[^/]+|http:\\/\\/(127\\.0\\.0\\.1|localhost)(:[0-9]+)?)$/;", "const TEAM_URL = /^https?:\\/\\/[^/]+$/;", "test/limits.test.ts"],
  ["API paths under a Share match loosely", "src/api.ts", "} else if (SLUG.test(b) && parts.length <= 4) {", "} else if (SLUG.test(b)) {", "test/api.test.ts"],
  ["a request body is read to its end before the cap", "src/http.ts", "    if (size > max) return null;\n", "", "test/limits.test.ts"],
  ["the token form has no size cap", "src/index.ts", "const raw = await readCapped(req, MAX_FORM_BYTES);", "const raw = await readCapped(req, 1e12);", "test/viewer.test.ts"],
  ["a refused publish uploads anyway", "src/store.ts", "    if (!reserved.meta.changes) return null;\n", "", "test/storage.test.ts"],
  ["a written Version leaves its upload in the ledger", "src/store.ts", "const inserted = (await this.db.batch([...statements, claim]))", "const inserted = (await this.db.batch([...statements]))", "test/limits.test.ts"],
  ["an expired reservation can be claimed", "src/store.ts", "due_at > ${CLOCK}", "due_at > 0", "test/store-expiry.test.ts"],
  ["no storage cap", "src/store.ts", 'const ROOM = "(SELECT COALESCE(SUM(size), 0) FROM versions) + (SELECT COALESCE(SUM(size), 0) FROM trash) + ? <= ?";', 'const ROOM = "(? > -1 OR ? > -1)";', "test/limits.test.ts"],
  ["the gate check follows API redirects", "scripts/setup.mjs", 'api = await fetch(url + "/api/shares", { redirect: "manual", signal });', 'api = await fetch(url + "/api/shares", { signal });', "test/operator.test.ts"],
  ["gate requests have no deadline", "scripts/setup.mjs", "const signal = AbortSignal.timeout(Math.min(10_000, left));", "const signal = undefined;", "test/operator.test.ts"],
  ["the gate check polls past its budget", "scripts/setup.mjs", "    if (left <= 0) break;\n", "", "test/operator.test.ts"],
  ["setup lets Wrangler and cf use different accounts", "scripts/setup.mjs", "if (c[0].id !== mine.id) throw new Error(", "if (false) throw new Error(", "test/operator.test.ts"],
  ["setup reads only the first page of Workers", "scripts/setup.mjs", "if (batch.length === 0) return all;", "if (batch.length >= 0) return all.concat(batch);", "test/operator.test.ts"],
  ["setup moves another Worker's Custom Domain", "scripts/setup.mjs", "if (other) throw new Error(", "if (false) throw new Error(", "test/operator.test.ts"],
  ["setup replaces a DNS record it does not own", "scripts/setup.mjs", "if (foreign) throw new Error(", "if (false) throw new Error(", "test/operator.test.ts"],
  ["the gate check accepts another team's sign-in", "scripts/setup.mjs", "if (to.origin !== teamUrl) return false;", "", "test/operator.test.ts"],
  ["the gate check accepts another application's sign-in", "scripts/setup.mjs", 'if (to.searchParams.get("kid") !== aud) return false;', "", "test/operator.test.ts"],
  ["the gate check accepts another hostname's sign-in", "scripts/setup.mjs", "return to.pathname === `/cdn-cgi/access/login/${host}`;", "return true;", "test/operator.test.ts"],
  ["setup accepts a domain outside its zones", "scripts/setup.mjs", "if (!zone) throw new Error(", "if (false) throw new Error(", "test/operator.test.ts"],
  ["setup accepts a zone that is not active", "scripts/setup.mjs", '.find((z) => z.name === name && z.status === "active");', ".find((z) => z.name === name);", "test/operator.test.ts"],
  ["setup trusts a malformed cf answer", "scripts/setup.mjs", "if (!Array.isArray(out)) throw new Error(", "if (false) throw new Error(", "test/operator.test.ts"],
  ["setup writes before it checks the domain", "scripts/setup.mjs", "    checkDomain(inst, cf);\n", "", "test/operator.test.ts"],
  ["setup replaces a foreign address record", "scripts/setup.mjs", "ADDRESS_TYPES.has(r.type) && ", "false && ", "test/operator.test.ts"],
  ["the first deploy answers at the custom domain", "scripts/setup.mjs", "...(open && inst.domain ?", "...(inst.domain ?", "test/operator.test.ts"],
  ["an Instance with a Custom Domain stays on workers.dev", "scripts/setup.mjs", "workers_dev: open && !inst.domain,", "workers_dev: open,", "test/operator.test.ts"],
  ["setup accepts a deploy that left workers.dev on beside the domain", "scripts/setup.mjs", "if (dev) throw", "if (false) throw", "test/operator.test.ts"],
  ["an Instance records every request", "scripts/setup.mjs", "invocation_logs: false", "invocation_logs: true", "test/operator.test.ts"],
  ["an Instance records traces", "scripts/setup.mjs", "traces: { enabled: false }", "traces: { enabled: true }", "test/operator.test.ts"],
  ["no rate limit", "src/api.ts", '  if (method !== "GET") {\n    // Fails closed', '  if (false) {\n    // Fails closed', "test/limits.test.ts"],
  ["the CLI follows redirects with its token", "packages/cli/src/api.ts", 'redirect: "manual",', 'redirect: "follow",', "test/cli-safety.test.ts"],
  ["the CLI sends plain http beyond loopback", "packages/cli/src/config.ts", 'if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) {', "if (false) {", "test/cli-safety.test.ts"],
  ["the CLI reads an answer of any size", "packages/cli/src/api.ts", "if (size > MAX_RESPONSE_BYTES) break;", "", "test/cli-safety.test.ts"],
  ["a title's newline forges a row", "packages/cli/src/bin.ts", 'const cell = (s: string) => s.replace(/[\\t\\n]/g, " ");', "const cell = (s: string) => s;", "test/cli-safety.test.ts"],
  ["a server's error message forges a hint line", "packages/cli/src/bin.ts", "`error: ${cell(e.message)}", "`error: ${e.message}", "test/cli-safety.test.ts"],
  ["publish follows a link on the way to the file", "packages/cli/src/files.ts", "open(real, flags | O_NOFOLLOW_ANY)", "open(real, flags)", "test/cli-safety.test.ts"],
  ["a token name may carry control characters", "src/index.ts", "if (!name || name.length > 64 || /(?![\\u200c\\u200d])[\\p{Cc}\\p{Cf}]/u.test(name)) {", "if (!name || name.length > 64) {", "test/viewer.test.ts"],
  ["the token command prints control characters", "scripts/token.mjs", 'const name = t.name.replace(/(?![\\u200c\\u200d])[\\p{Cc}\\p{Cf}]/gu, "");', "const name = t.name;", "test/operator.test.ts"],
  ["the CLI prints tokens", "packages/cli/src/bin.ts", 'const redact = (s: string) => s.replace(/hg_[A-Za-z0-9]{40}/g, "hg_…");', "const redact = (s: string) => s;", "test/cli-safety.test.ts"],
  ["an environment token goes to the Instance a project file names", "packages/cli/src/config.ts", "if (!env.HTMLGATE_URL?.trim()) {", "if (false) {", "test/cli.test.ts"],
  ["a stored token goes to any Instance", "packages/cli/src/config.ts", "const token = (await readStore(p.store))[chosen.api_url];", "const token = Object.values(await readStore(p.store))[0];", "test/cli.test.ts"],
  ["login takes its URL from the project config", "packages/cli/src/bin.ts", "const raw = args[0] ?? envUrl;", "const raw = args[0] ?? envUrl ?? (await selectInstance(p, process.env)).api_url;", "test/cli.test.ts"],
  ["login saves a token it never checked", "packages/cli/src/bin.ts", "  await new InstanceApi(origin, token).listShares({ pageSize: 1 });\n  await save(p, origin, token);", "  await save(p, origin, token);", "test/cli.test.ts"],
  ["the credential store is readable by others", "packages/cli/src/config.ts", 'const fh = await open(tmp, "wx", 0o600);', 'const fh = await open(tmp, "wx", 0o644);', "test/cli.test.ts"],
  ["login writes through a symlink", "packages/cli/src/config.ts", "if (st.isSymbolicLink()) throw", "if (false) throw", "test/cli.test.ts"],
  ["a matched upsert drops the Share's other tags", "packages/cli/src/bin.ts", "matched ? fields : { ...fields, ...(hasMeta ? { metadata } : {}) }", "{ ...fields, ...(hasMeta ? { metadata } : {}) }", "test/cli.test.ts"],
  ["the CLI waits forever on a stalled answer", "packages/cli/src/api.ts", "        signal: AbortSignal.timeout(TIMEOUT_MS),\n", "", "test/reviewer-cli-fork.test.ts"],
  ["a relative XDG_CONFIG_HOME puts credentials in the project", "packages/cli/src/config.ts", "env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ?", "env.XDG_CONFIG_HOME ?", "test/cli.test.ts"],
  ["a loose credentials directory stays loose", "packages/cli/src/config.ts", "  await chmod(dir, 0o700);", "  void chmod;", "test/reviewer-cli-fork.test.ts"],
  ["login sends the environment's token to any Instance", "packages/cli/src/bin.ts", "envToken && envUrl && instanceOrigin(envUrl) === origin)", "envToken)", "test/cli.test.ts"],
  ["a stored origin is trusted as written", "packages/cli/src/config.ts", 'if (typeof token !== "string" || !isOrigin(origin)) throw damaged();', 'if (typeof token !== "string") throw damaged();', "test/reviewer-cli-redesign.test.ts"],
  ["text output passes terminal escapes through", "packages/cli/src/bin.ts", 'const printable = (s: string) => s.replace(/[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]/g, "");', "const printable = (s: string) => s;", "test/cli-safety.test.ts"],
  ["upsert updates the first of several matches", "packages/cli/src/bin.ts", "if (found.total > 1) {", "if (false) {", "test/cli.test.ts"],
  ["the landing loses its CSP", "site/src/worker.ts", `  "content-security-policy": "default-src 'none'; style-src 'self'; img-src 'self'; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",\n`, "", "test/site.test.ts"],
  // The view counter hangs off the same if, so the preview branch keeps its shape and only its header is dropped.
  ["the landing preview is indexable", "site/src/worker.ts", 'if (url.hostname !== site.hostname) res.headers.set("x-robots-tag", "noindex");', 'if (false) res.headers.set("x-robots-tag", "noindex");', "test/site.test.ts"],
  ["the landing loses HSTS", "site/src/worker.ts", '"strict-transport-security": "max-age=31536000; includeSubDomains",', "", "test/site.test.ts"],
  ["a visitor off the Allowlist gets a not-found unlike a Viewer's", "src/index.ts", 'if (!who) return notFound(cfg.language, { home: "viewer" });', 'if (!who) return notFound(cfg.language, { home: "author" });', "test/viewer.test.ts"],
  ["pages allow any inline style", "src/pages.ts", "style-src 'sha256-${await styleHash()}'", "style-src 'unsafe-inline'", "test/viewer.test.ts"],
  ["an unknown page language is accepted", "src/config.ts", '  if (language !== "en" && language !== "pt-BR") return null;\n', "", "test/language.test.ts"],
  ["anyone signed in can erase a Share", "src/index.ts", "if (!isAuthor || req.method !== \"POST\") return lost();\n    const again", "if (req.method !== \"POST\") return lost();\n    const again", "test/erase.test.ts"],
  ["erasing answers a GET", "src/index.ts", "if (!isAuthor || req.method !== \"POST\") return lost();\n    const again", "if (!isAuthor) return lost();\n    const again", "test/erase.test.ts"],
  ["erasing skips the Origin check", "src/index.ts", "    if (!sameOrigin(req, url)) return again(403, { error: \"refused\" });\n", "", "test/erase.test.ts"],
  ["the erase form takes any size", "src/index.ts", "    if (form === null) return again(413, { error: \"too-large\" });\n", "", "test/erase.test.ts"],
  ["erasing leaves the bodies to the hourly cleanup", "src/index.ts", "    ctx.waitUntil(store.eraseBodies(slug, target.keys).catch((e) => console.error(\"erase cleanup\", e)));\n", "", "test/erase.test.ts"],
  ["an erased Share keeps its Versions", "src/store.ts", "this.db.prepare(`DELETE FROM versions WHERE slug IN (${own})`)", "this.db.prepare(`DELETE FROM versions WHERE 0 AND slug IN (${own})`)", "test/erase.test.ts"],
  ["erasing reaches another Author's Versions", "src/store.ts", "const own = \"SELECT slug FROM shares WHERE slug = ? AND author = ?\";", "const own = \"SELECT slug FROM shares WHERE slug = ? AND ? IS NOT NULL\";", "test/erase.test.ts"],
  ["erasing reaches another Author's Share", "src/store.ts", "this.db.prepare(\"DELETE FROM shares WHERE slug = ? AND author = ?\").bind(slug, author),", "this.db.prepare(\"DELETE FROM shares WHERE slug = ? AND ? IS NOT NULL\").bind(slug, author),", "test/erase.test.ts"],
  ["every visitor sees the Erase control", "src/index.ts", "const erase = prefix === \"s\" && who === cfg.author;", "const erase = true;", "test/erase.test.ts"],
  ["the home's form erases without asking", "src/index.ts", "    if (fields.get(\"confirm\") !== \"1\") return again(200, { confirm: { slug, title: target.title } });\n", "", "test/erase.test.ts"],
  ["erasing keeps the legacy bodies", "src/store.ts", "      ...(legacy ? [this.db.prepare(`DELETE FROM versions_d1_legacy WHERE slug IN (${own})`).bind(slug, author)] : []),\n", "", "test/erase.test.ts"],
  ["erasing skips the R2 prefix sweep", "src/store.ts", "      for (const o of page.objects) found.set(o.key, o.size);\n", "", "test/erase.test.ts"],
  ["erasing sweeps every Share's bodies", "src/store.ts", "const page = await this.bodies.list({ prefix: `bodies/${slug}/`, cursor });", "const page = await this.bodies.list({ prefix: \"bodies/\", cursor });", "test/erase.test.ts"],
  ["the erase lookup ignores the Author", "src/store.ts", "WHERE d.slug = ? AND d.author = ?\")\n      .bind(slug, author)\n      .all<{ title: string; body_key: string | null }>", "WHERE d.slug = ? AND ? IS NOT NULL\")\n      .bind(slug, author)\n      .all<{ title: string; body_key: string | null }>", "test/erase.test.ts"],
  ["the home's erase question does not escape the title", "src/pages.ts", "<p>${t.eraseAsk(escapeHtml(note.confirm.title))} <code>", "<p>${t.eraseAsk(note.confirm.title)} <code>", "test/reviewer-erase.test.ts"],
  ["the Share page's erase question does not escape the title", "src/pages.ts", "<p>${t.eraseAsk(escapeHtml(d.title))}</p>", "<p>${t.eraseAsk(d.title)}</p>", "test/reviewer-erase.test.ts"],
  ["the erased note shows any text from the link", "src/index.ts", "const note = isAuthor && erased !== null && SLUG.test(erased) && !(await store.eraseTarget(cfg.author, erased)) ? { erased } : undefined;", "const note = isAuthor && erased !== null && !(await store.eraseTarget(cfg.author, erased)) ? { erased } : undefined;", "test/reviewer-erase.test.ts"],
  ["a link makes the home say a live Share was erased", "src/index.ts", "const note = isAuthor && erased !== null && SLUG.test(erased) && !(await store.eraseTarget(cfg.author, erased)) ? { erased } : undefined;", "const note = isAuthor && erased !== null && SLUG.test(erased) ? { erased } : undefined;", "test/reviewer-erase.test.ts"],
  ["any www host redirects to the landing", "site/src/worker.ts", "if (url.hostname === `www.${site.hostname}`) {", 'if (url.hostname.startsWith("www.")) {', "test/site.test.ts"],
  ["omitted metadata overwrites a concurrent change", "src/store.ts", "COALESCE(?, tags)", "COALESCE(?, '{}')", "test/concurrent-fields.test.ts"],
  ["omitted description overwrites a concurrent change", "src/store.ts", "CASE WHEN ? = 1 THEN ? ELSE description END", "CASE WHEN ? = 1 THEN ? ELSE 'lost' END", "test/concurrent-fields.test.ts"],
  ["the CLI loses literal metadata keys", "packages/cli/src/files.ts", "const out: Record<string, string> = Object.create(null);", "const out: Record<string, string> = {};", "test/cli-metadata.test.ts"],
  ["the live benchmark sends a token over remote HTTP", "scripts/bench.ts", 'if (target.protocol !== "https:" && !(target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))) {', "if (false) {", "test/reviewer-release-tools.test.ts"],
  ["the benchmark follows an authenticated publish redirect", "scripts/bench.ts", 'method: "POST", headers, redirect: "manual", body: JSON.stringify({ html: sampleShare()', 'method: "POST", headers, body: JSON.stringify({ html: sampleShare()', "test/reviewer-release-tools.test.ts"],
  ["smoke follows an authenticated redirect", "scripts/smoke.mjs", '    redirect: "manual",\n', "", "test/reviewer-release-tools.test.ts"],
  ["the benchmark trusts an unsafe cleanup slug", "scripts/bench.ts", ' || !SLUG.test(value.slug)', "", "test/reviewer-release-tools.test.ts"],
  ["smoke trusts an unsafe cleanup slug", "scripts/smoke.mjs", "  must(typeof slug === \"string\" && /^[A-Za-z0-9]{12}$/.test(slug), \"publish: invalid slug in the created Share response\");\n", "", "test/reviewer-release-tools.test.ts"],
  ["a mutation timeout is mistaken for an assertion", "scripts/mutation-reporter.mjs", '  if (failed.some((t) => !t.errors.length || t.errors.some((e) => e.name !== "AssertionError"))) return broken("test timeout or runtime failure, not an assertion", failed);\n', "", "test/mutation-gate.test.ts"],
  ["the benchmark accepts credentials in its destination", "scripts/bench.ts", "target.username || target.password || ", "", "test/reviewer-release-tools.test.ts"],
  ["the benchmark accepts a destination path", "scripts/bench.ts", ' || target.pathname !== "/"', "", "test/reviewer-release-tools.test.ts"],
  ["the benchmark accepts a destination query", "scripts/bench.ts", "target.search || ", "", "test/reviewer-release-tools.test.ts"],
  ["the benchmark accepts a destination fragment", "scripts/bench.ts", "target.hash || ", "", "test/reviewer-release-tools.test.ts"],
  ["the benchmark accepts an unfinished load event", "scripts/bench.ts", "t.loadEventEnd <= t.startTime", "t.loadEventEnd < t.startTime", "test/reviewer-release-tools.test.ts"],
  ["the benchmark accepts out-of-order navigation timing", "scripts/bench.ts", " || t.loadEventEnd < t.responseStart", "", "test/reviewer-release-tools.test.ts"],
  ["the benchmark accepts a missing HTTP status", "scripts/bench.ts", "t.responseStatus < 100", "t.responseStatus < 0", "test/reviewer-release-tools.test.ts"],
  ["the benchmark measures a browser's slow first sandboxed loads", "scripts/bench.ts", "const WARMUP = 10;", "const WARMUP = 3;", "test/reviewer-release-tools.test.ts"],
  ["a mutation accepts an incomplete global teardown", "scripts/mutate.mjs", "if (teardown " + '!== "complete")', "if (false)", "test/mutation-gate.test.ts"],
  ["a mutation accepts a late runner close error", "scripts/mutation-reporter.mjs", '  if (stderr.trim()) return broken(`runner stderr must be diagnosed: ${stderr.trim().slice(0, 1000)}`);\n', "", "test/mutation-gate.test.ts"],
  ["site files lose the sandbox header", "src/index.ts", "const SITE_HEADERS = {\n  \"content-security-policy\": `sandbox ${SHARE_SANDBOX}; frame-ancestors 'self'`,", "const SITE_HEADERS = {\n  \"content-security-policy\": `frame-ancestors 'self'`,", "test/sites.test.ts"],
  ["site files send a referrer", "src/index.ts", "  // A ticket in the URL never leaves in a Referer by default.\n  \"referrer-policy\": \"no-referrer\",\n", "  // A ticket in the URL never leaves in a Referer by default.\n", "test/sites.test.ts"],
  ["errors under /f/ send a referrer", "src/index.ts", "  headers.set(\"referrer-policy\", \"no-referrer\");\n", "", "test/sites.test.ts"],
  ["a Gated site's files are served on /p/", "src/store.ts", "${live(\"d.\")} ${publicOnly ? \"AND d.public = 1\" : \"\"}`)\n      .bind(n, path, slug, author)", "${live(\"d.\")} ${publicOnly ? \"\" : \"\"}`)\n      .bind(n, path, slug, author)", "test/sites.test.ts"],
  ["a deleted Share's site files stay readable", "src/store.ts", "AND ${live(\"d.\")} ${publicOnly ? \"AND d.public = 1\" : \"\"}`)\n      .bind(n, path, slug, author)", "${publicOnly ? \"AND d.public = 1\" : \"\"}`)\n      .bind(n, path, slug, author)", "test/sites.test.ts"],
  ["an expired ticket still opens files", "src/index.ts", "  if (t.exp <= Date.now()) {", "  if (false) {", "test/sites.test.ts"],
  ["a ticket outlives its person's place on the Allowlist", "src/index.ts", "  if (!t || !cfg.allowlist.has(t.email)) return notFound(cfg.language);", "  if (!t) return notFound(cfg.language);", "test/sites.test.ts"],
  ["a ticket opens another Version", "src/index.ts", "serveSiteFile(env, cfg, t.slug, t.n, rest, false)", "serveSiteFile(env, cfg, t.slug, 1, rest, false)", "test/sites.test.ts"],
  ["a ticket is not bound to its Instance", "src/ticket.ts", "`htmlgate ticket 1 ${aud}`", "`htmlgate ticket 1`", "test/sites.test.ts"],
  ["an encoded slash passes in a site's path", "src/zip.ts", "  if (decoded.some((p) => p.includes(\"/\"))) return null;\n", "", "test/sites.test.ts"],
  ["a zip may climb out with ..", "src/zip.ts", "s === \"\" || s === \".\" || s === \"..\"", "s === \"\" || s === \".\"", "test/zip.test.ts"],
  ["a zip may hold a symbolic link", "src/zip.ts", "if (type === S_IFLNK) throw", "if (false) throw", "test/zip.test.ts"],
  ["a zip's entries may overlap", "src/zip.ts", "if (byStart[i]!.start < byStart[i - 1]!.end) throw", "if (false) throw", "test/zip.test.ts"],
  ["a zip file's size is taken on trust", "src/zip.ts", "if (out !== e.size) throw invalid(", "if (false) throw invalid(", "test/zip.test.ts"],
  ["a zip file's checksum is ignored", "src/zip.ts", "if ((sum ^ 0xffffffff) >>> 0 !== crc) throw", "if (false) throw", "test/zip.test.ts"],
  ["a site file serves past its size", "src/zip.ts", "if (chunk.byteLength > left) {", "if (false) {", "test/zip.test.ts"],
  ["an Instance without a ticket key runs", "src/config.ts", "  if (!isTicketKey(ticketKey)) return null;\n", "", "test/config.test.ts"],
  ["the CLI publishes a folder's dotfiles", "packages/cli/src/files.ts", "      if (e.name.startsWith(\".\")) continue;\n", "", "test/cli-site.test.ts"],
  ["an expired Share's body stays viewable", "src/store.ts", "${live(\"d.\")} ${publicOnly ? \"AND d.public = 1\" : \"\"}`)\n      .bind(n, slug, author)", "d.deleted_at IS NULL ${publicOnly ? \"AND d.public = 1\" : \"\"}`)\n      .bind(n, slug, author)", "test/expiry.test.ts"],
  ["an expired Share stays readable through the API", "src/store.ts", "WHERE d.slug = ? AND d.author = ? AND ${live(\"d.\")}`)\n      .bind(slug, author)\n      .first<ShareRow>();", "WHERE d.slug = ? AND d.author = ? AND d.deleted_at IS NULL`)\n      .bind(slug, author)\n      .first<ShareRow>();", "test/expiry.test.ts"],
  ["an expiry date out of range is accepted", "src/api.ts", "at < now + MIN_EXPIRY_MS || at > now + MAX_EXPIRY_MS", "false", "test/expiry.test.ts"],
  ["a publish re-checks liveness after its INSERT", "src/store.ts", "updated_at = ?, changed_by = ?, changed_at = ? WHERE slug = ? AND author = ? AND ${WROTE}`)", "updated_at = ?, changed_by = ?, changed_at = ? WHERE slug = ? AND author = ? AND ${live()} AND ${WROTE}`)", "test/store-sites-expiry.test.ts"],
  ["expiry cleanup deletes Versions without queuing their bodies", "src/store.ts", "      this.db.prepare(`INSERT INTO trash (body_key, size, due_at) SELECT body_key, size, ? FROM versions WHERE slug IN (${due})`).bind(now, now, CLEANUP_BATCH),\n", "", "test/store-sites-expiry.test.ts"],
  ["an expired Share can still be made public", "src/store.ts", "UPDATE shares SET public = ?, changed_by = ?, changed_at = ?\n        WHERE slug = ? AND author = ? AND ${live()}`)", "UPDATE shares SET public = ?, changed_by = ?, changed_at = ?\n        WHERE slug = ? AND author = ? AND deleted_at IS NULL`)", "test/store-sites-expiry.test.ts"],
  ["an expired Share's fields still change", "src/store.ts", "updated_at = ?, changed_by = ?, changed_at = ? WHERE slug = ? AND author = ? AND ${live()}`)\n      .bind(title ?? null, description !== undefined ? 1 : 0, description ?? null, tags ?? null,\n        set,", "updated_at = ?, changed_by = ?, changed_at = ? WHERE slug = ? AND author = ? AND deleted_at IS NULL`)\n      .bind(title ?? null, description !== undefined ? 1 : 0, description ?? null, tags ?? null,\n        set,", "test/store-sites-expiry.test.ts"],
  ["an expired Share is still listed", "src/store.ts", "const where = [\"d.author = ?\", live(\"d.\")];", "const where = [\"d.author = ?\", \"d.deleted_at IS NULL\"];", "test/expiry.test.ts"],
  ["an expired ticket's navigation is not sent back through the gate", "src/index.ts", "    return navigating ? redirect(`/s/${t.slug}`) : notFound(cfg.language);", "    return notFound(cfg.language);", "test/sites.test.ts"],
  ["a zip may hide data after its directory", "src/zip.ts", "  if (cdStart + cdSize < eocd) throw invalid(", "  if (false) throw invalid(", "test/zip.test.ts"],
  ["an encrypted zip entry is accepted", "src/zip.ts", "    if (flags & 0x41) throw invalid(", "    if (false) throw invalid(", "test/zip.test.ts"],
  ["a zip's local header may disagree with its directory", "src/zip.ts", "    if (u16(start + 8) !== method || localName.length !== nameBytes.length || !localName.every((b, k) => b === nameBytes[k])) {", "    if (false) {", "test/zip.test.ts"],
  ["a zip may hold one path twice", "src/zip.ts", "    if (seen.has(e.path)) throw invalid(", "    if (false) throw invalid(", "test/zip.test.ts"],
  ["a site may hold more than 1,000 files", "src/zip.ts", "  if (files.length > SITE_LIMITS.files) throw tooLarge(", "  if (false) throw tooLarge(", "test/zip.test.ts"],
  ["a site's file may pass 5 MiB", "src/zip.ts", "    if (e.size > SITE_LIMITS.fileBytes) throw tooLarge(", "    if (false) throw tooLarge(", "test/zip.test.ts"],
  ["a site may pass 25 MiB unzipped", "src/zip.ts", "  if (total > SITE_LIMITS.totalBytes) throw tooLarge(", "  if (false) throw tooLarge(", "test/zip.test.ts"],
  ["a zip path may hold a backslash", "src/zip.ts", "  if (path.includes(\"\\\\\")) throw invalid(", "  if (false) throw invalid(", "test/zip.test.ts"],
  ["a site's zip download loses its CSP", "src/api.ts", "    \"content-security-policy\": \"default-src 'none'; frame-ancestors 'none'\",\n    \"content-disposition\"", "    \"content-disposition\"", "test/sites.test.ts"],
  ["an expired Share stays on the Author's home", "src/store.ts", "WHERE d.author = ?1 AND ${live(\"d.\")} ORDER BY d.updated_at DESC, d.slug LIMIT ?2`)", "WHERE d.author = ?1 AND d.deleted_at IS NULL ORDER BY d.updated_at DESC, d.slug LIMIT ?2`)", "test/store-sites-expiry.test.ts"],
  ["Homebrew accepts a CLI version mismatch", "scripts/cli-install.mjs", "if (actual !== version) throw new Error(`CLI version mismatch:", "if (false) throw new Error(`CLI version mismatch:", "test/cli-brew.test.ts"],
  ["Homebrew installs without refreshing its tap", "scripts/cli-install.mjs", '    command("git", ["-C", repository, "fetch", "--tags", "--prune", "origin"]);', '', "test/cli-brew.test.ts"],
  ["Homebrew installs when brew is absent", "scripts/cli-install.mjs", "if (available.error || available.status !== 0) {", "if (false) {", "test/cli-brew.test.ts"],
  ["Homebrew installs without the release tag in its tap", "scripts/cli-install.mjs", '      command("git", ["-C", repository, "rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);', '', "test/cli-brew.test.ts"],
  ["Homebrew accepts a formula/archive candidate mismatch", "scripts/cli-install.mjs", "if (!archive.equals(expectedArchive) || source !== selectedSource || verified.version !== version) {", "if (false) {", "test/cli-brew.test.ts"],
  ["an Instance without its write limit takes changes", "src/api.ts", '    if (!env.WRITE_LIMIT) return fail(503, "server_misconfigured", "This Instance is missing its write limit. The Operator must run setup.");\n', "", "test/launch-audit.test.ts"],
  ["a request of fields alone may be as large as a page", "src/api.ts", "fieldsOnly ? MAX_FIELDS_BYTES : MAX_REQUEST_BYTES", "MAX_REQUEST_BYTES", "test/launch-audit.test.ts"],
  ["a failed purge stops the trash from being emptied", "src/index.ts", '        console.error("scheduled", name, e);\n        failures.push(e);', '        console.error("scheduled", name, e);\n        throw e;', "test/launch-audit.test.ts"],
  ["a sign-in failure logs the token", "src/access.ts", 'e instanceof Error ? e.message : "");', 'e instanceof Error ? e.message : "", token);', "test/launch-audit.test.ts"],
  ["setup deploys uncommitted source", "scripts/setup.mjs", "  if (dirty) throw new Error(", "  if (false) throw new Error(", "test/launch-audit.test.ts"],
  ["the visibility switch takes unknown fields", "src/api.ts", "Object.keys(body).length !== 1", "false", "test/redteam.test.ts"],
  ["the landing cannot play its own video", "site/src/worker.ts", `media-src 'self'; `, "", "test/site.test.ts"],
  ["ZIP publishing loses literal metadata keys","src/api.ts","const metadata: Record<string, string> = Object.create(null);","const metadata: Record<string, string> = {};","test/sites.test.ts"],
  ["ZIP publishing ignores an unknown prototype field","src/api.ts","const out: Record<string, unknown> = Object.create(null);","const out: Record<string, unknown> = {};","test/sites.test.ts"],
  ["setup skips ownership before remote writes","scripts/setup.mjs","const owned = checkOwnership(inst, db, listWorkers(cf), listApplications());","const owned = { worker: listWorkers(cf).find((w) => w.name === inst.name), app: listApplications().find((a) => a.name === `htmlgate: ${inst.name}`) };","test/setup-ownership.test.ts"],
  ["setup accepts a foreign Access destination","scripts/setup.mjs","throw new Error(\"Access application does not uniquely belong to this Instance's Worker.\");","void 0;","test/setup-ownership.test.ts"],
  ["setup ignores active storage bindings","scripts/setup.mjs","throw new Error(\"Active Worker bindings do not belong to this Instance.\");","void 0;","test/setup-ownership.test.ts"],
  ["setup inspects only one traffic-serving version","scripts/setup.mjs","for (const version of versions.filter((v) => v.percentage > 0)) {","for (const version of versions.filter((v) => v.percentage > 0).slice(0, 1)) {","test/setup-ownership.test.ts"],
  ["setup adopts an unmarked or open bootstrap","scripts/setup.mjs","throw new Error(\"Worker is not a marked closed htmlgate bootstrap; cannot establish Instance ownership.\");","void 0;","test/setup-ownership.test.ts"],
  ["setup omits the bootstrap marker","scripts/setup.mjs","vars: { ...vars, HTMLGATE_INSTANCE: inst.name },","vars,","test/setup-ownership.test.ts"],
  ["setup accepts an incomplete active deployment","scripts/setup.mjs","throw new Error(\"Missing or malformed active deployment; cannot establish Instance ownership.\");","void 0;","test/setup-ownership.test.ts"],
  ["setup reads only the first Access application page","scripts/setup.mjs","if (!batch.length) return all;","if (batch.length >= 0) return all.concat(batch);","test/setup-ownership.test.ts"],
  ["setup reuses a public managed bucket domain","scripts/setup.mjs","managed?.enabled !== false","false","test/setup-ownership.test.ts"],
  ["setup reuses public or unknown custom bucket domains","scripts/setup.mjs","!Array.isArray(custom?.domains) || custom.domains.some((d) => !d || d.enabled !== false)","false","test/setup-ownership.test.ts"],
  ["smoke accepts a cleartext Access redirect","scripts/smoke.mjs","to?.protocol === \"https:\"","true","test/reviewer-release-tools.test.ts"],
  ["smoke accepts Access text outside the team hostname","scripts/smoke.mjs","/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.cloudflareaccess\\.com$/.test(to.hostname)","true","test/reviewer-release-tools.test.ts"],
  ["smoke accepts credentials or a port in an Access redirect","scripts/smoke.mjs","&& !to.username && !to.password && !to.port","","test/reviewer-release-tools.test.ts"],
  ["smoke leaves fetch and body reads unbounded","scripts/smoke.mjs","return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });","return fetch(url, init);","test/reviewer-release-tools.test.ts"],
  ["the mutation reporter certifies mixed skipped controls","scripts/mutation-reporter.mjs","typeof t.name !== \"string\" || ![\"passed\", \"failed\"].includes(t.state)","typeof t.name !== \"string\" || ![\"passed\", \"failed\", \"skipped\"].includes(t.state)","test/mutation-reporter.test.ts"],
  ["setup creates a database before R2 safety discovery","scripts/setup.mjs","  step(\"finding or creating the R2 bucket\");","  if (freshDb) sh(WRANGLER, [\"d1\", \"create\", dbName]);\n  step(\"finding or creating the R2 bucket\");","test/setup-ownership.test.ts"],
  ["setup ignores malformed competing Access destinations","scripts/setup.mjs","if (!validDestinations) throw new Error(\"Malformed Access destinations; cannot establish Instance ownership.\");","if (false) throw new Error(\"Malformed Access destinations; cannot establish Instance ownership.\");","test/setup-ownership.test.ts"],
  ["setup reads only the first R2 bucket page","scripts/setup.mjs","if (!buckets.length) return all;","return all.concat(buckets);","test/setup-ownership.test.ts"],
  ["setup accepts non-advancing or duplicate R2 bucket names","scripts/setup.mjs","if (bucket.name <= after) throw new Error(\"R2 bucket names are ambiguous or not advancing.\");","if (false) throw new Error(\"R2 bucket names are ambiguous or not advancing.\");","test/setup-ownership.test.ts"],
  ["Homebrew accepts corrupted source archive bytes","scripts/cli-archive.mjs","if (digest(archive) !== metadata.sha256) throw new Error(","if (false) throw new Error(","test/cli-brew.test.ts"],
  ["Homebrew accepts stale source archive inputs","scripts/cli-archive.mjs","if (!archive.equals(buildArchive(join(root, \"packages/cli\")))) throw new Error(","if (false) throw new Error(","test/cli-brew.test.ts"],
  ["Homebrew accepts an old or unlinked rebuild receipt","scripts/cli-install.mjs","if (info?.full_name !== FORMULA || info.linked_keg !== expectedVersion ||\n        !Array.isArray(info.installed) || !info.installed.some((entry) => entry.version === expectedVersion)) {","if (false) {","test/cli-brew.test.ts"],
  ["Homebrew accepts stale installed artifact bytes","scripts/cli-install.mjs","if (!readFileSync(join(libexec, name)).equals(readFileSync(join(build, name)))) throw new Error(","if (false) throw new Error(","test/cli-brew.test.ts"],
  ["Homebrew accepts a release tag with different candidate inputs","scripts/cli-install.mjs","      command(\"git\", [\"-C\", repository, \"diff\", \"--exit-code\", `${tag}^{commit}`, \"--\",\n        \"Formula/htmlgate.rb\", `Formula/sources/${verified.archive}`, ...CLI_INPUTS.map((name) => `packages/cli/${name}`)]);","","test/cli-brew.test.ts"],
  ["Homebrew accepts duplicate formula metadata","scripts/cli-archive.mjs","if (lines.length !== 1 || declarations !== expected) throw new Error(","if (false) throw new Error(","test/cli-brew.test.ts"],
  ["setup accepts a project inside another Git checkout","scripts/setup.mjs","if (realpathSync(root) !== realpathSync(ROOT)) {","if (false) {","test/reviewer-launch-audit-docs.test.ts"],
];

const onlyAt = process.argv.indexOf("--only");
const only = onlyAt > 0 ? process.argv[onlyAt + 1] ?? "" : "";
const chosen = MUTATIONS.filter(([name]) => name.includes(only));
if (chosen.length === 0) throw new Error(`No mutation name contains "${only}".`);

if (process.argv.includes("--check")) {
  let invalid = 0;
  for (const [name, file, from] of chosen) {
    const count = readFileSync(file, "utf8").split(from).length - 1;
    if (count !== 1) { console.log(`BROKEN  ${name}: anchor found ${count} times in ${file}`); invalid++; }
  }
  if (!invalid) console.log(`Verified ${chosen.length} unique mutation anchors without changing source.`);
  process.exit(invalid ? 1 : 0);
}

// Without a handler a signal kills Node with the violation still planted. With one, the running test finishes
// or is stopped (Ctrl-C reaches it too), the source is restored, and nothing else is planted. A handler runs only
// when the event loop turns and the test runs synchronously, so the loop yields after every mutation.
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { interrupted = true; });

/** Runs the chosen mutations and returns the exit code. */
async function gate() {
let failures = 0;
let completed = 0;
try {
for (const [name, file, from, to, testFile] of chosen) {
  const original = readFileSync(file, "utf8");
  const count = original.split(from).length - 1;
  if (count !== 1) {
    console.log(`BROKEN  ${name}: anchor found ${count} times in ${file}`);
    failures++;
    continue;
  }
  const directory = mkdtempSync(join(tmpdir(), "htmlgate-mutation-"));
  const reportFile = join(directory, "result.json");
  const teardownFile = join(directory, "teardown.txt");
  let result;
  try {
    writeFileSync(file, original.replace(from, to));
    // A CLI mutation must still compile: a build error is not a caught protection.
    if (file.startsWith("packages/cli/")) {
      execFileSync("node_modules/.bin/tsc", ["-p", "packages/cli", "--noEmit"], { stdio: "pipe" });
    }
    const run = spawnSync("node_modules/.bin/vitest", ["run", testFile, "--reporter", "./scripts/mutation-reporter.mjs"], {
      encoding: "utf8", stdio: "pipe", env: { ...process.env, HTMLGATE_MUTATION_REPORT: reportFile, HTMLGATE_MUTATION_TEARDOWN: teardownFile },
    });
    if (run.error) throw run.error;
    let report;
    try { report = JSON.parse(readFileSync(reportFile, "utf8")); } catch {}
    result = classifyMutation(report, run.status, run.signal, testFile, run.stderr);
    let teardown;
    try { teardown = readFileSync(teardownFile, "utf8"); } catch {}
    if (teardown !== "complete") result = { state: "BROKEN", reason: "global teardown did not complete", failed: [] };
  } catch (e) {
    result = { state: "BROKEN", reason: `mutation setup failed: ${e.message}`, failed: [] };
  } finally {
    writeFileSync(file, original);
    rmSync(directory, { recursive: true, force: true });
  }
  await new Promise((r) => setImmediate(r));
  if (interrupted) break;
  completed++;
  console.log(`${result.state.padEnd(7)} ${name} (${testFile}): ${result.reason}`);
  for (const test of result.failed) console.log(`  ${test.name}: ${test.errors.map((e) => `${e.name}: ${e.message}`).join("; ") || "(no error recorded)"}`);
  if (result.state !== "CAUGHT") failures++;
  if (result.state === "BROKEN") break;
}
} finally {
  // The last test run built the mutated CLI; rebuild only from restored source, even after a broken run.
  execFileSync("node_modules/.bin/tsc", ["-p", "packages/cli"], { stdio: "pipe" });
}
if (interrupted) {
  console.log(`Interrupted after ${completed} of ${chosen.length}: the source is restored and the gate did not complete.`);
  return 130;
}
if (completed !== chosen.length) console.log(`Stopped after ${completed} of ${chosen.length}: the full gate did not complete.`);
console.log(failures === 0 ? `\nAll ${chosen.length} planted violations were caught.` : `\n${failures} of ${chosen.length} not caught.`);
return failures === 0 ? 0 : 1;
}

gate().then((code) => process.exit(code), (e) => {
  console.error(e);
  process.exit(1);
});
