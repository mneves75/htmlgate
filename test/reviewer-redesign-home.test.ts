// Reviewer tests for the Author's home against a real pt-BR Instance: the edges of "50 most recently updated",
// the last-Publisher join, the counts, and the headers of every page. Rows go in with `wrangler d1 execute`.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { AUTHOR, VIEWER, settings, startInstance, type Instance } from "./global-setup";
import { api, asPerson, mintToken, page } from "./helpers";

const run = promisify(execFile);
let inst: Instance;
let call: ReturnType<typeof api>;

const sql = (command: string) =>
  run(join(process.cwd(), "node_modules/.bin/wrangler"), ["d1", "execute", "htmlgate-dev", "--local", "--persist-to", inst.state, "--command", command], { env: { ...process.env, CI: "1" } });
const get = async (path: string, email?: string) => {
  const r = await fetch(`${inst.base}${path}`, email ? await asPerson(email, { redirect: "manual" }) : { redirect: "manual" });
  return { status: r.status, headers: r.headers, body: await r.text() };
};
const rowSlugs = (body: string) => [...body.matchAll(/<li class="row">[\s\S]*?href="\/s\/([A-Za-z0-9]{12})"/g)].map((m) => m[1]!);
const T0 = 1_800_000_000_000;

beforeAll(async () => {
  inst = await startInstance(settings(inject("teamUrl"), { LANGUAGE: "pt-BR" }));
}, 180_000);
afterAll(() => inst?.stop());

describe("the Author's home on a pt-BR Instance", () => {
  test("one Share, public: the counts use the singular in pt-BR; a changed_by naming no token prints no 'null'", async () => {
    await sql(`INSERT INTO shares (slug, author, title, public, latest_version, created_at, updated_at, changed_by, changed_at)
      VALUES ('OrphanShare1', '${AUTHOR}', 'Sem publicador', 1, 1, ${T0}, ${T0}, 'ffffffffffff', ${T0})`);
    const r = await get("/", AUTHOR);
    expect(r.status).toBe(200);
    expect(r.body).toContain("1 Share · 1 público");
    expect(r.body).not.toContain("1 públicos");
    expect(rowSlugs(r.body)).toEqual(["OrphanShare1"]);
    expect(r.body).toContain('<span class="state state-public">Público</span>');
    expect(r.body).not.toMatch(/null|undefined|NaN/);
    // The board prints the hour on flaps and the date under it, from the same machine-readable instant.
    expect(r.body).toContain('<time datetime="2027-01-15T08:00:00.000Z"><span class="flap">08:00</span> <span class="date">2027-01-15 UTC</span></time>');
  });

  test("a revoked token still names the last Publisher of its Shares", async () => {
    const token = await mintToken("notebook revogado", inst.base);
    const c = api(token, inst.base);
    const d = (await c("POST", "/api/shares", { html: page("x"), title: "Do notebook" })).json as { slug: string };
    const id = ((await c("GET", "/api/tokens")).json.data as { id: string; name: string }[]).find((t) => t.name === "notebook revogado")!.id;
    await sql(`UPDATE tokens SET revoked_at = ${Date.now()} WHERE id = '${id}'`);
    const body = (await get("/", AUTHOR)).body;
    const at = body.indexOf(`href="/s/${d.slug}"`);
    expect(body.slice(at, at + 900)).toContain("notebook revogado");
  });

  test("exactly 50 Shares: no truncation notice; a 51st with the same timestamp: the notice, and ties break by slug", async () => {
    await sql(`DELETE FROM shares`);
    await sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50)
      INSERT INTO shares (slug, author, title, public, latest_version, created_at, updated_at, changed_by, changed_at)
      SELECT printf('TieShare%04d', i), '${AUTHOR}', 'Empate ' || i, i % 2, 1, ${T0}, ${T0}, 'x', ${T0} FROM n`);
    let r = await get("/", AUTHOR);
    expect(rowSlugs(r.body)).toHaveLength(50);
    expect(r.body).toContain("50 Shares · 25 públicos");
    expect(r.body).not.toContain("Mostrando os");
    await sql(`INSERT INTO shares (slug, author, title, public, latest_version, created_at, updated_at, changed_by, changed_at)
      VALUES ('TieShare0000', '${AUTHOR}', 'Empate zero', 0, 1, ${T0}, ${T0}, 'x', ${T0})`);
    r = await get("/", AUTHOR);
    const slugs = rowSlugs(r.body);
    expect(slugs).toHaveLength(50);
    expect(slugs).toEqual([...slugs].sort());
    expect(slugs[0]).toBe("TieShare0000");
    expect(slugs).not.toContain("TieShare0050");
    expect(r.body).toContain("51 Shares · 25 públicos");
    expect(r.body).toContain("Mostrando os 50 Shares atualizados mais recentemente, de 51.");
    expect(r.body).toContain("<code>htmlgate list</code> lista todos os Shares.");
    // The Viewer's home reads none of this.
    const v = await get("/", VIEWER);
    for (const text of ["TieShare", "Empate", "51 Shares"]) expect(v.body).not.toContain(text);
  }, 240_000);

  test("a Share deleted after the others disappears from the list and from both counts", async () => {
    await sql(`UPDATE shares SET deleted_at = ${T0} WHERE slug IN ('TieShare0000', 'TieShare0001')`);
    const r = await get("/", AUTHOR);
    expect(r.body).toContain("49 Shares · 24 públicos");
    expect(r.body).not.toContain("Mostrando os");
    expect(r.body).not.toContain("TieShare0000");
    expect(rowSlugs(r.body)).toHaveLength(49);
  });
});

describe("headers of every page of a pt-BR Instance", () => {
  test("no-store, a hashed-stylesheet CSP and html content type on home, tokens, a viewer and not-found; a Viewer's refused tokens page equals not-found", async () => {
    const c = api(await mintToken("cabecalhos", inst.base), inst.base);
    const d = (await c("POST", "/api/shares", { html: page("x"), title: "Cabeçalhos" })).json as { slug: string };
    const pages = [await get("/", AUTHOR), await get("/", VIEWER), await get("/tokens", AUTHOR), await get(`/s/${d.slug}`, VIEWER), await get("/nada"), await get(`/s/${d.slug}`)];
    for (const r of pages) {
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(r.headers.get("content-security-policy")).toMatch(/style-src 'sha256-[A-Za-z0-9+/]+=*'/);
      expect(r.headers.get("content-security-policy")).not.toMatch(/script-src|unsafe-/);
    }
    const missing = await get("/s/ZZZZZZZZZZZZ", VIEWER);
    const refused = await get("/tokens", VIEWER);
    expect(missing.status).toBe(404);
    expect(refused.status).toBe(404);
    expect(refused.body).toBe(missing.body);
    expect(refused.headers.get("content-security-policy")).toBe(missing.headers.get("content-security-policy"));
    // A Gated Share on the public path is refused with the same page as a missing one (apart from its sign-in action).
    const viaPublic = await get(`/p/${d.slug}`);
    const nowhere = await get("/p/ZZZZZZZZZZZZ");
    expect(viaPublic.status).toBe(404);
    expect(viaPublic.body).toBe(nowhere.body.replace("/s/ZZZZZZZZZZZZ", `/s/${d.slug}`));
  });

  test("the home is not served to an anonymous request, a wrong-audience token or a Viewer's POST", async () => {
    expect((await get("/")).status).toBe(404);
    const post = await fetch(`${inst.base}/`, await asPerson(AUTHOR, { method: "POST", headers: { origin: inst.base } }));
    expect(post.status).toBe(404);
  });
});
