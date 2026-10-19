// The people pages in a real browser, driven by agent-browser (Vercel Labs), because what a browser
// sends with a form (Origin, Sec-Fetch-Site) depends on the page's own headers. Access is stood in for
// by the signed header the browser sends on every request.
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { writeZip } from "../packages/cli/src/zip";
import { AUTHOR, VIEWER } from "./global-setup";
import { axeViolations } from "./a11y";
import { accessJwt, api, base } from "./helpers";

const run = promisify(execFile);
const BIN = join(process.cwd(), "node_modules/.bin/agent-browser");
const SESSION = `htmlgate-test-${process.pid}`;
let evil: Server;
let evilUrl: string;

/** One agent-browser command in a headless session (this file's own unless named). */
async function abIn(session: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(BIN, ["--session", session, ...args], { timeout: 30_000 });
  return stdout.trim();
}
const ab = (...args: string[]) => abIn(SESSION, ...args);

/** Waits until the page's transitions (the cross-page view transition, the reveal fade) have finished,
 *  as a person would before clicking: a click during a view transition lands on its overlay. */
const settle = (session = SESSION) => abIn(session, "wait", "--fn", "document.getAnimations().length === 0");

/** Creates a token by filling in the token page, as the Author would, in the given browser session. */
async function createTokenIn(session: string, name: string): Promise<string> {
  await abIn(session, "open", `${base}/tokens`);
  await abIn(session, "find", "label", "Name", "fill", name);
  await abIn(session, "find", "role", "button", "click", "--name", "Create token");
  await abIn(session, "wait", "--text", "Copy it now");
  await settle(session);
  return abIn(session, "get", "text", "#new-token");
}
const createTokenInPage = (name: string) => createTokenIn(SESSION, name);

beforeAll(async () => {
  await ab("open", "about:blank");
  await ab("set", "headers", JSON.stringify({ "cf-access-jwt-assertion": await accessJwt(AUTHOR) }));
  // A page on another site (localhost, while the Instance is on 127.0.0.1) that auto-submits to the token page,
  // or, at /erase/<slug>, to the erase form.
  evil = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    const erase = /^\/erase\/([A-Za-z0-9]{12})$/.exec(req.url ?? "");
    res.end(erase
      ? `<form method="post" action="${base}/erase"><input name="share" value="${erase[1]}"><input name="confirm" value="1"></form><script>document.forms[0].submit()</script>`
      : `<form method="post" action="${base}/tokens"><input name="name" value="stolen"></form><script>document.forms[0].submit()</script>`);
  });
  await new Promise<void>((r) => evil.listen(0, "127.0.0.1", r));
  evilUrl = `http://localhost:${(evil.address() as { port: number }).port}/`;
});

afterAll(async () => {
  await ab("close").catch(() => {});
  // beforeAll may have failed (Chrome did not start) before the server existed; keep that error the only one.
  if (evil) await new Promise<void>((r) => evil.close(() => r()));
});

const AUDIT = `${SESSION}-a11y`;

/** axe violations on the audit session's current page, limited to WCAG 2.x A and AA rules. */
const violations = () => axeViolations((...args) => abIn(AUDIT, ...args));

describe("accessibility of every page, in light and dark", () => {
  afterAll(async () => abIn(AUDIT, "close").catch(() => {}));

  test.each(["light", "dark"])("%s: home, tokens, a new token, the viewer and not-found pass axe for WCAG 2.2 AA", async (scheme) => {
    await abIn(AUDIT, "open", "about:blank");
    await abIn(AUDIT, "set", "media", scheme);
    // Headers are set after the media, which resets them.
    await abIn(AUDIT, "set", "headers", JSON.stringify({ "cf-access-jwt-assertion": await accessJwt(AUTHOR) }));
    await abIn(AUDIT, "open", `${base}/tokens`);
    await abIn(AUDIT, "find", "label", "Name", "fill", `a11y ${scheme}`);
    await abIn(AUDIT, "find", "role", "button", "click", "--name", "Create token");
    await abIn(AUDIT, "wait", "--text", "Copy it now");
    await settle(AUDIT);
    const call = api(await abIn(AUDIT, "get", "text", "#new-token"));
    expect(await violations(), "tokens with a new token").toEqual([]);
    const { json: d } = await call("POST", "/api/shares", { html: "<!doctype html><title>t</title><h1>Hello</h1>", title: "A Share with a fairly long title for the bar" });
    await call("PUT", `/api/shares/${d.slug}`, { html: "<!doctype html><title>t</title><h1>Two</h1>" });
    // One navigation to the Share, so the metrics table has a row to audit rather than its empty state.
    await abIn(AUDIT, "open", `${base}/s/${d.slug}`);
    await settle(AUDIT);
    // The report's numbers have to be readable in a real browser: visible text, inside the card, and no dark flap
    // cells on the light ground (the first version of this page passed its HTML test and still showed empty cells).
    await abIn(AUDIT, "open", `${base}/metrics`);
    await settle(AUDIT);
    // `eval` answers with the printed value, so a JSON string comes back quoted once more.
    const printed: unknown = JSON.parse(await abIn(AUDIT, "eval", `JSON.stringify((() => {
      const card = document.querySelector(".metrics").getBoundingClientRect();
      const cell = document.querySelector(".metrics-row .m-views");
      const box = cell.getBoundingClientRect();
      // The number itself, not the cell: the lbl span holds "30 days", whose digits would satisfy a looser check.
      const number = cell.querySelector(":scope > span:not(.lbl)");
      const total = document.querySelector(".metrics-row .m-total");
      return {
        flaps: document.querySelectorAll(".metrics-row .flap").length,
        number: number ? number.textContent.trim() : "",
        numberVisible: number ? number.getBoundingClientRect().width > 0 : false,
        totalVisible: total ? total.getBoundingClientRect().width > 0 : false,
        width: Math.round(box.width),
        inside: box.right <= card.right + 1 && box.left >= card.left - 1,
        rows: document.querySelectorAll(".metrics-row").length,
      };
    })())`));
    const layout = (typeof printed === "string" ? JSON.parse(printed) : printed) as {
      flaps: number; number: string; numberVisible: boolean; totalVisible: boolean; width: number; inside: boolean; rows: number;
    };
    expect(layout.flaps, "no board flaps on the report").toBe(0);
    expect(layout.rows).toBeGreaterThan(0);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.inside, "the count stays inside the card").toBe(true);
    expect(layout.number, "the count cell holds the number itself").toMatch(/^\d+$/);
    expect(layout.numberVisible, "the number is rendered, not hidden").toBe(true);
    expect(layout.totalVisible, "the all-time count is rendered too").toBe(true);
    for (const [label, path] of [["home", "/"], ["tokens", "/tokens"], ["metrics", "/metrics"], ["viewer", `/s/${d.slug}`]]) {
      await abIn(AUDIT, "open", `${base}${path}`);
      await settle(AUDIT);
      expect(await violations(), label).toEqual([]);
    }
    // The Author's Erase question, open over the Share.
    await abIn(AUDIT, "open", `${base}/s/${d.slug}`);
    await settle(AUDIT);
    await abIn(AUDIT, "click", "details.confirm summary");
    expect(await violations(), "viewer with Erase open").toEqual([]);
    // The not-found page is sandboxed (an opaque origin with no scripts), where axe cannot run.
    // Audit the same bytes from a data URL instead: same markup and styles, minus the sandbox.
    const notFound = await (await fetch(`${base}/p/ZZZZZZZZZZZZ`)).text();
    await abIn(AUDIT, "open", `data:text/html;base64,${Buffer.from(notFound).toString("base64")}`);
    await settle(AUDIT);
    expect(await violations(), "not found").toEqual([]);
    // At phone width: the Author's board, the tokens list and the viewer, which all change layout there.
    await abIn(AUDIT, "set", "viewport", "390", "844");
    for (const [label, path] of [["home", "/"], ["tokens", "/tokens"], ["metrics", "/metrics"], ["viewer", `/s/${d.slug}?v=1`]]) {
      await abIn(AUDIT, "open", `${base}${path}`);
      await settle(AUDIT);
      expect(await violations(), `${label} at 390 px`).toEqual([]);
      expect(await abIn(AUDIT, "eval", "document.documentElement.scrollWidth <= window.innerWidth"), `${label} scrolls sideways`).toBe("true");
    }
    await abIn(AUDIT, "open", `${base}/s/${d.slug}`);
    await settle(AUDIT);
    await abIn(AUDIT, "click", "details.confirm summary");
    expect(await violations(), "viewer with Erase open at 390 px").toEqual([]);
    expect(await abIn(AUDIT, "eval", "(() => { const r = document.querySelector('details.confirm .ask').getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight; })()"), "Erase question on screen").toBe("true");
    // A Viewer's home, with the Viewer's own sign-in.
    await abIn(AUDIT, "set", "headers", JSON.stringify({ "cf-access-jwt-assertion": await accessJwt(VIEWER) }));
    await abIn(AUDIT, "open", `${base}/`);
    await settle(AUDIT);
    expect(await violations(), "a Viewer's home").toEqual([]);
  }, 180_000);
});

describe("the pages work by keyboard and touch", () => {
  const KB = `${SESSION}-kb`;
  afterAll(async () => abIn(KB, "close").catch(() => {}));

  test("the stylesheet applies under the CSP, the first Tab reaches the skip link, and every control is at least 24 px", async () => {
    await abIn(KB, "open", "about:blank");
    await abIn(KB, "set", "headers", JSON.stringify({ "cf-access-jwt-assertion": await accessJwt(AUTHOR) }));
    const call = api(await createTokenIn(KB, "keyboard"));
    const { json: d } = await call("POST", "/api/shares", { html: "<!doctype html><title>t</title><h1>Hi</h1>", title: "Keyboard" });
    // A one-letter title makes the shortest link the board can draw: it must still be a 24 px target.
    await call("POST", "/api/shares", { html: "<!doctype html><title>t</title><h1>K</h1>", title: "K" });
    for (const path of ["/", "/tokens", `/s/${d.slug}`]) {
      await abIn(KB, "open", `${base}${path}`);
      await settle(KB);
      // A custom property only the page's own stylesheet sets: a blocked stylesheet leaves it empty.
      expect(await abIn(KB, "eval", "getComputedStyle(document.documentElement).getPropertyValue('--signal').trim().length > 0"), path).toBe("true");
      await abIn(KB, "press", "Tab");
      expect(await abIn(KB, "eval", "document.activeElement.classList.contains('skip')"), `${path}: first Tab`).toBe("true");
      // The shown skip link must not cover another control (axe target-size).
      expect(await axeViolations((...args) => abIn(KB, ...args)), `${path}: skip link shown`).toEqual([]);
      // WCAG 2.5.8: links inside running text are exempt; every other control has a 24 px target.
      const small = await abIn(KB, "eval", `JSON.stringify([...document.querySelectorAll('a[href], button, summary, input')]
        .filter((e) => e.getClientRects().length && getComputedStyle(e).display !== 'inline' && !e.classList.contains('skip'))
        .filter((e) => { const r = e.getBoundingClientRect(); return r.width < 24 || r.height < 24; })
        .map((e) => e.outerHTML.slice(0, 80)))`);
      expect(JSON.parse(JSON.parse(small)), path).toEqual([]);
    }
  }, 120_000);
});

describe("the token page in a real browser", () => {
  test("the Author creates a token by submitting the form, and it works on the API", async () => {
    const token = await createTokenInPage("browser laptop");
    expect(token).toMatch(/^hg_[A-Za-z0-9]{40}$/);
    expect((await api(token)("GET", "/api/shares")).status).toBe(200);
  });

  test("the Author revokes a token with its button, and it stops working", async () => {
    const token = await createTokenInPage("browser revoke");
    // Revoking takes two steps: open the row's Revoke control, then confirm.
    await ab("click", 'details[data-token-name="browser revoke"] summary');
    await ab("wait", "--text", "stop working on their next request");
    await ab("find", "role", "button", "click", "--name", "Revoke browser revoke");
    await ab("wait", "--text", "Revoked");
    expect((await api(token)("GET", "/api/shares")).status).toBe(401);
  });

  test("the Author erases a Share from its page, and its link stops working", async () => {
    const call = api(await createTokenInPage("browser erase"));
    const { json: d } = await call("POST", "/api/shares", { html: "<!doctype html><title>t</title><h1>Bye</h1>", title: "To erase" });
    await ab("open", `${base}/s/${d.slug}`);
    await settle();
    await ab("click", "details.confirm summary");
    await ab("wait", "--text", "cannot be undone");
    await ab("find", "role", "button", "click", "--name", "Erase for good");
    await ab("wait", "--text", "for good: its Versions");
    expect(await ab("get", "url")).toBe(`${base}/?erased=${d.slug}`);
    expect((await call("GET", `/api/shares/${d.slug}`)).status).toBe(404);
  });

  test("a form on another site cannot erase a Share, even with the Author's browser", async () => {
    const call = api(await createTokenInPage("erase-attack-form"));
    const { json: d } = await call("POST", "/api/shares", { html: "<!doctype html><title>t</title><h1>Keep</h1>", title: "Keep me" });
    await ab("open", `${evilUrl}erase/${d.slug}`);
    // Any answer: refused, the question, or erased; so a missing check fails the assertion below, not this wait.
    await ab("wait", "--fn", "/Refused|Erase this Share\\?|for good:/.test(document.body?.innerText ?? '')");
    expect(await ab("get", "text", "body")).toContain("Refused");
    expect((await call("GET", `/api/shares/${d.slug}`)).status).toBe(200);
  });

  test("a Share's own script cannot erase another Share through the Author's browser", async () => {
    const call = api(await createTokenInPage("erase-attack-share"));
    const { json: victim } = await call("POST", "/api/shares", { html: "<!doctype html><title>t</title><h1>Keep</h1>", title: "Victim" });
    const html = `<!doctype html><title>x</title><script>
      fetch("/erase", { method: "POST", credentials: "include", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "share=${victim.slug}&confirm=1" })
        .then(r => r.text()).then(t => { document.title = "fetched " + t.length; }, () => { document.title = "blocked"; });
    </script>`;
    const { json: d } = await call("POST", "/api/shares", { html, title: "attack" });
    await ab("open", `${base}/s/${d.slug}/raw`);
    await ab("wait", "--fn", "document.title !== 'x'");
    expect((await call("GET", `/api/shares/${victim.slug}`)).status).toBe(200);
  });

  test("a form on another site cannot create a token, even with the Author's browser", async () => {
    await ab("open", evilUrl);
    // Wait for either answer, so a token page that accepts the form fails this assertion instead of a wait timeout.
    await ab("wait", "--fn", "/Refused|Copy it now/.test(document.body?.innerText ?? '')");
    expect(await ab("get", "text", "body")).toContain("Refused");
    expect(await ab("get", "count", "#new-token")).toBe("0");
  });

  test("a Share's own script cannot create a token through the Viewer's browser", async () => {
    const call = api(await createTokenInPage("share-attack-setup"));
    const before = (await call("GET", "/api/tokens")).json.data.length;
    const html = `<!doctype html><title>x</title><script>
      fetch("/tokens", { method: "POST", credentials: "include", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "name=from-share" })
        .then(r => r.text()).then(t => { document.title = "fetched " + t.length; }, () => { document.title = "blocked"; });
    </script>`;
    const { json: d } = await call("POST", "/api/shares", { html, title: "attack" });
    await ab("open", `${base}/s/${d.slug}/raw`);
    await ab("wait", "--fn", "document.title !== 'x'");
    expect((await call("GET", "/api/tokens")).json.data.length).toBe(before);
  });
});

describe("a Gated site in a real browser", () => {
  const SITE_SESSION = `${SESSION}-site`;
  afterAll(async () => abIn(SITE_SESSION, "close").catch(() => {}));

  test("its files load under the viewer's ticket in a session that carries no Access token at all", async () => {
    const files: Record<string, string> = {
      "index.html": `<!doctype html><html lang="en"><title>site</title><link rel="stylesheet" href="css/style.css">
<p id="p">styled</p><img id="img" src="img/dot.svg" alt="dot" width="4" height="4">
<iframe id="nested" src="docs/index.html" title="nested"></iframe>
<script type="module" src="js/main.mjs"></script>
<script>
addEventListener("message", (e) => { if (e.data === "nested") document.body.dataset.nested = "yes"; });
fetch("data.json").then((r) => r.json()).then((j) => { document.body.dataset.fetched = String(j.ok); }, () => { document.body.dataset.fetched = "failed"; });
</script></html>`,
      "css/style.css": "#p { color: rgb(1, 2, 3); }",
      "img/dot.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#123"/></svg>',
      "js/main.mjs": 'import { v } from "./dep.mjs"; document.body.dataset.module = v;',
      "js/dep.mjs": 'export const v = "yes";',
      "data.json": '{"ok":true}',
      "docs/index.html": '<!doctype html><title>docs</title><script>parent.postMessage("nested", "*")</script>',
    };
    const zip = writeZip(Object.entries(files).map(([path, text]) => ({ path, data: new TextEncoder().encode(text) })));
    const token = await createTokenInPage("site");
    const res = await fetch(`${base}/api/shares?title=Site`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/zip" }, body: zip });
    const slug = ((await res.json()) as any).slug as string;

    // The viewer, as the signed-in Author sees it, frames the site under a ticket.
    await ab("open", `${base}/s/${slug}`);
    const src = await ab("get", "attr", "#share", "src");
    expect(src).toMatch(/^\/f\/[A-Za-z0-9_-]+\/$/);

    // A session with no headers at all opens that same address: everything the site loads must come by ticket alone.
    await abIn(SITE_SESSION, "open", "about:blank");
    await abIn(SITE_SESSION, "open", base + src);
    await abIn(SITE_SESSION, "wait", "--fn", "document.body && document.body.dataset.fetched !== undefined && document.body.dataset.module !== undefined");
    expect(await abIn(SITE_SESSION, "eval", "getComputedStyle(document.getElementById('p')).color")).toContain("rgb(1, 2, 3)");
    expect(await abIn(SITE_SESSION, "eval", "document.getElementById('img').naturalWidth")).toBe("4");
    expect(await abIn(SITE_SESSION, "eval", "document.body.dataset.fetched")).toContain("true");
    expect(await abIn(SITE_SESSION, "eval", "document.body.dataset.module")).toContain("yes");
    // A frame of the site's own page is refused: its parent is an opaque origin, which frame-ancestors 'self' does not
    // match. Measured in Chromium on 2026-10-09 and documented as a limit in docs/operator.md.
    await abIn(SITE_SESSION, "wait", "1500");
    expect(await abIn(SITE_SESSION, "eval", "document.body.dataset.nested ?? 'no'")).toContain("no");
  });
});
