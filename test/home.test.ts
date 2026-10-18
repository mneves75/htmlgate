// The Author's home lists the Author's Shares; nobody else's home lists anything. Its own Instance, so
// every Share and count on the page is one these tests made.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { axeViolations } from "./a11y";
import { AUTHOR, VIEWER, settings, startInstance, type Instance } from "./global-setup";
import { accessJwt, api, asPerson, mintToken, page } from "./helpers";

const run = promisify(execFile);
let inst: Instance;
let call: ReturnType<typeof api>;
// A Publisher name a page could mistake for markup. Token names may hold any printable character.
const HOSTILE_PUBLISHER = `pub<b>"&'x`;

beforeAll(async () => {
  inst = await startInstance(settings(inject("teamUrl")));
});
afterAll(() => inst?.stop());

const home = async (email: string) => {
  const r = await fetch(`${inst.base}/`, await asPerson(email));
  return { status: r.status, body: await r.text() };
};
const publish = async (title: string) => (await call("POST", "/api/shares", { html: page(title), title })).json as { slug: string };
/** The rows of the Shares list, in page order: each row's slug from its link. */
const rowSlugs = (body: string) => [...body.matchAll(/<li class="row">[\s\S]*?href="\/s\/([A-Za-z0-9]{12})"/g)].map((m) => m[1]);

describe("with no Shares", () => {
  test("the home teaches the publish commands and lists nothing", async () => {
    const r = await home(AUTHOR);
    expect(r.status).toBe(200);
    expect(r.body).toContain("No Shares yet");
    expect(r.body).toContain(`htmlgate login ${inst.base}`);
    expect(rowSlugs(r.body)).toEqual([]);
  });

  test("the empty home passes axe in light and dark, at desktop and phone width", async () => {
    const BIN = join(process.cwd(), "node_modules/.bin/agent-browser");
    const SESSION = `htmlgate-home-${process.pid}`;
    const ab = async (...args: string[]) => (await run(BIN, ["--session", SESSION, ...args], { timeout: 30_000 })).stdout.trim();
    try {
      for (const scheme of ["light", "dark"]) {
        for (const width of ["1280", "390"]) {
          await ab("open", "about:blank");
          await ab("set", "viewport", width, "844");
          await ab("set", "media", scheme);
          await ab("set", "headers", JSON.stringify({ "cf-access-jwt-assertion": await accessJwt(AUTHOR) }));
          await ab("open", `${inst.base}/`);
          await ab("wait", "--fn", "document.getAnimations().length === 0");
          expect(await axeViolations(ab), `${scheme} ${width}`).toEqual([]);
        }
      }
    } finally {
      await ab("close").catch(() => {});
    }
  }, 120_000);
});

describe("with Shares", () => {
  const slugs: Record<string, string> = {};

  beforeAll(async () => {
    call = api(await mintToken(HOSTILE_PUBLISHER, inst.base), inst.base);
    slugs.old = (await publish("Oldest report")).slug;
    slugs.hostile = (await publish(`<img src=x onerror=alert(1)> & "q"`)).slug;
    slugs.open = (await publish("Public dashboard")).slug;
    await call("POST", `/api/shares/${slugs.open}/visibility`, { public: true });
    slugs.deleted = (await publish("Deleted draft")).slug;
    await call("DELETE", `/api/shares/${slugs.deleted}`);
    // A Share of another Author, as if the Operator changed the Author: it is in the database but not this Author's.
    await run(join(process.cwd(), "node_modules/.bin/wrangler"), ["d1", "execute", "htmlgate-dev", "--local", "--persist-to", inst.state, "--command",
      `INSERT INTO shares (slug, author, title, public, latest_version, created_at, updated_at, changed_by, changed_at) VALUES ('ForeignShare', 'someone-else@example.com', 'Foreign secret', 1, 1, ${Date.now()}, ${Date.now() + 60_000}, 'x', 1)`],
      { env: { ...process.env, CI: "1" } });
    // The newest change: a second Version of the oldest Share moves it to the top.
    await call("PUT", `/api/shares/${slugs.old}`, { html: page("Oldest report, again") });
  }, 120_000);

  test("lists the Author's Shares, most recently updated first, each linked to its viewer", async () => {
    const r = await home(AUTHOR);
    expect(r.status).toBe(200);
    expect(rowSlugs(r.body)).toEqual([slugs.old, slugs.open, slugs.hostile]);
  });

  test("each row shows its state, its latest Version and its last Publisher", async () => {
    const { body } = await home(AUTHOR);
    const row = (slug: string) => body.slice(body.indexOf(`href="/s/${slug}"`) - 200, body.indexOf(`href="/s/${slug}"`) + 900);
    expect(row(slugs.open!)).toContain('<span class="state state-public">Public</span>');
    expect(row(slugs.hostile!)).toContain('<span class="state state-gated">Gated</span>');
    expect(row(slugs.old!)).toContain(">v2<");
    expect(row(slugs.old!)).toContain("pub&lt;b&gt;&quot;&amp;&#39;x");
  });

  test("titles and Publisher names are escaped", async () => {
    const { body } = await home(AUTHOR);
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;");
    expect(body).not.toContain("<img src=x");
    expect(body).not.toContain("pub<b>");
  });

  test("the counts cover the Author's live Shares only: 3 Shares, 1 public", async () => {
    const { body } = await home(AUTHOR);
    expect(body).toContain("3 Shares · 1 public");
  });

  test("a deleted Share and another Author's Share appear nowhere on the page", async () => {
    const { body } = await home(AUTHOR);
    for (const text of ["Deleted draft", slugs.deleted!, "Foreign secret", "ForeignShare"]) expect(body).not.toContain(text);
  });

  test("a Viewer's home lists nothing: no title, slug or count of any Share", async () => {
    const r = await home(VIEWER);
    expect(r.status).toBe(200);
    for (const text of ["Oldest report", "Public dashboard", "onerror", ...Object.values(slugs), "3 Shares", "1 public", "<li class=\"row\">"]) {
      expect(r.body, text).not.toContain(text);
    }
    // Control: the same strings are on the Author's page.
    expect((await home(AUTHOR)).body).toContain("Public dashboard");
  });

  test("someone not signed in gets the not-found page, with nothing of the list", async () => {
    const r = await fetch(`${inst.base}/`);
    const body = await r.text();
    expect(r.status).toBe(404);
    for (const text of ["Oldest report", "Public dashboard", ...Object.values(slugs), "Shares ·"]) expect(body, text).not.toContain(text);
  });

  test("past 50 Shares the home shows the 50 most recently updated and says how many there are", async () => {
    for (let i = 0; i < 50; i++) await publish(`Bulk ${String(i).padStart(2, "0")}`);
    const { body } = await home(AUTHOR);
    const rows = rowSlugs(body);
    expect(rows).toHaveLength(50);
    expect(body).toContain("Bulk 49");
    expect(body).not.toContain("Oldest report");
    expect(body).toContain("53 Shares · 1 public");
    expect(body).toContain("Showing the 50 most recently updated of 53.");
    expect(body).toContain("<code>htmlgate list</code>");
  }, 180_000);
});
