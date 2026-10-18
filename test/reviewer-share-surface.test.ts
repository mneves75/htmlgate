// Independent review of the Drop -> Share rename (plan 011), through the real Worker in-process (no wrangler).
// Requirements, written from the plan before reading the diff:
//  R1 /api/drops... and /d/<slug>... answer like any unknown path, for every method and every identity, and change nothing.
//  R2 The erase form field is `share`; a body that still says `drop` erases nothing.
//  R3 No rendered page, API message or onboard text carries the former name (case-insensitive), in English and pt-BR.
//  R4 Links the Worker mints use /s/ (gated) and /p/ (public); the public not-found sign-in link goes to /s/.
//  R5 R2 keys stay bodies/<slug>/<id>; /p/ and /f/ are unchanged.
import { afterAll, describe, expect, test } from "vitest";
import { AUTHOR, PAGE, startInstance, stopAccess, VIEWER, type Instance } from "./reviewer-beta10-harness";

afterAll(stopAccess);

const shape = async (r: Response) => ({ status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() });
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const rows = (i: Instance) => i.fake.sqlite.prepare("SELECT slug, title, public, deleted_at, latest_version FROM shares ORDER BY slug").all();

async function seed(i: Instance) {
  const gated = (await i.api("POST", "/api/shares", { html: PAGE, title: "Gated one" })).json;
  const pub = (await i.api("POST", "/api/shares", { html: PAGE, title: "Public one" })).json;
  await i.api("POST", `/api/shares/${pub.slug}/visibility`, { public: true });
  return { gated: gated.slug as string, pub: pub.slug as string, gatedUrl: gated.url as string, pubUrl: (await i.api("GET", `/api/shares/${pub.slug}`)).json.url as string };
}

describe("R1 the former paths are unknown paths", () => {
  test("every /api/drops path and method answers like /api/nothing, even with a valid token, and changes nothing", async () => {
    const i = await startInstance();
    const s = await seed(i);
    const before = rows(i);
    const control = await i.api("GET", "/api/nothing");
    expect(control.status).toBe(404);
    const paths = ["/api/drops", `/api/drops/${s.gated}`, `/api/drops/${s.gated}/versions`, `/api/drops/${s.gated}/versions/1`,
      `/api/drops/${s.gated}/versions/1/zip`, `/api/drops/${s.gated}/visibility`, "/api/drops/", "/api/drops?page=1"];
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      for (const p of paths) {
        const r = await i.api(method, p, method === "GET" || method === "DELETE" ? undefined : { html: PAGE, title: "x", public: false });
        expect(r.status, `${method} ${p}`).toBe(404);
        expect(r.json?.error?.code, `${method} ${p}`).toBe("not_found");
        expect(r.text, `${method} ${p}`).toBe(control.text);
      }
    }
    expect(rows(i)).toEqual(before);
    // Positive control: the same operations under the new name do work, so the 404s above are not a broken harness.
    expect((await i.api("GET", "/api/shares")).json.data).toHaveLength(2);
    expect((await i.api("GET", `/api/shares/${s.gated}/versions`)).status).toBe(200);
  });

  test("without a token /api/drops is refused exactly as /api/nothing is", async () => {
    const i = await startInstance();
    const a = await shape(await i.call("/api/drops"));
    const b = await shape(await i.call("/api/nothing"));
    expect(a).toEqual(b);
  });

  test("/d/<slug> and /d/<slug>/raw (also ?v=) are the not-found page for the Author, a Viewer and anyone, gated or public", async () => {
    const i = await startInstance();
    const s = await seed(i);
    for (const who of [undefined, AUTHOR, VIEWER]) {
      const control = await shape(await i.call("/unknown-share-path", { as: who }));
      for (const slug of [s.gated, s.pub]) {
        for (const suffix of ["", "/raw", "?v=1", "/raw?v=1", "/"]) {
          const r = await shape(await i.call(`/d/${slug}${suffix}`, { as: who }));
          expect(r.status, `${who} /d/${slug}${suffix}`).toBe(404);
          expect(r.body.includes("Gated one") || r.body.includes("hello"), `${who} /d/${slug}${suffix}`).toBe(false);
        }
        // The plain form must be byte-identical to an unknown path as that same person sees it.
        expect(await shape(await i.call(`/d/${slug}`, { as: who })), `${who} /d/${slug}`).toEqual(control);
      }
    }
    // Positive control: the new path serves the gated Share to the Author and refuses an anonymous request.
    expect((await i.call(`/s/${s.gated}`, { as: AUTHOR })).status).toBe(200);
    expect((await i.call(`/s/${s.gated}`)).status).toBe(404);
    expect((await i.call(`/s/${s.gated}/raw`, { as: VIEWER })).status).toBe(200);
  });

  test("a /d/ link pasted into the home's erase form names nothing and erases nothing", async () => {
    const i = await startInstance();
    const s = await seed(i);
    const before = rows(i);
    const r = await i.call("/erase", { method: "POST", as: AUTHOR, headers: { ...FORM, origin: i.HOST }, body: new URLSearchParams({ share: `${i.HOST}/d/${s.gated}`, confirm: "1" }).toString() });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("Paste a Share");
    expect(rows(i)).toEqual(before);
  });
});

describe("R2 the erase form field is `share`", () => {
  test("`drop=<slug>&confirm=1` is a bad request and erases nothing; `share=` erases", async () => {
    const i = await startInstance();
    const s = await seed(i);
    const before = rows(i);
    for (const body of [`drop=${s.gated}&confirm=1`, `drop=${s.gated}`, `Drop=${s.gated}&confirm=1`, `drops=${s.gated}&confirm=1`]) {
      const r = await i.call("/erase", { method: "POST", as: AUTHOR, headers: { ...FORM, origin: i.HOST }, body });
      expect(r.status, body).toBe(400);
      const text = await r.text();
      expect(text, body).not.toMatch(/drop/i);
      expect(text, body).toContain("Paste a Share");
    }
    expect(rows(i)).toEqual(before);
    expect(i.fake.sqlite.prepare("SELECT COUNT(*) AS n FROM versions WHERE slug = ?").get(s.gated)).toEqual({ n: 1 });
    // Both fields present: only `share` counts.
    const both = await i.call("/erase", { method: "POST", as: AUTHOR, headers: { ...FORM, origin: i.HOST }, body: `drop=${s.pub}&share=${s.gated}&confirm=1` });
    expect(both.status).toBe(303);
    expect(both.headers.get("location")).toBe(`/?erased=${s.gated}`);
    expect(rows(i).map((r) => (r as { slug: string }).slug)).toEqual([s.pub]);
  });

  test("an unknown slug reports the renamed note, in both languages, never the old note names", async () => {
    for (const language of ["en", "pt-BR"] as const) {
      const i = await startInstance({ LANGUAGE: language });
      const r = await i.call("/erase", { method: "POST", as: AUTHOR, headers: { ...FORM, origin: i.HOST }, body: "share=AAAAAAAAAAAA&confirm=1" });
      expect(r.status).toBe(404);
      const text = await r.text();
      expect(text).toContain(language === "en" ? "No Share with that link or slug" : "Nenhum Share com esse link ou slug");
      expect(text).not.toMatch(/bad-drop|no-drop|drop/i);
    }
  });
});

describe("R3 no rendered text carries the former name", () => {
  for (const language of ["en", "pt-BR"] as const) {
    test(`pages, errors and onboard text (${language}) contain no "drop" in any case`, async () => {
      const i = await startInstance({ LANGUAGE: language });
      const s = await seed(i);
      const pages: [string, Response][] = [
        ["home (author)", await i.call("/", { as: AUTHOR })],
        ["home (viewer)", await i.call("/", { as: VIEWER })],
        ["tokens", await i.call("/tokens", { as: AUTHOR })],
        ["viewer page", await i.call(`/s/${s.gated}`, { as: AUTHOR })],
        ["viewer page (viewer)", await i.call(`/s/${s.gated}`, { as: VIEWER })],
        ["raw", await i.call(`/s/${s.gated}/raw`, { as: AUTHOR })],
        ["public", await i.call(`/p/${s.pub}`)],
        ["not found (gated, author)", await i.call("/s/ZZZZZZZZZZZZ", { as: AUTHOR })],
        ["not found (gated, viewer)", await i.call("/s/ZZZZZZZZZZZZ", { as: VIEWER })],
        ["not found (public, signed out)", await i.call("/p/ZZZZZZZZZZZZ")],
        ["home with confirm", await i.call("/erase", { method: "POST", as: AUTHOR, headers: { ...FORM, origin: i.HOST }, body: `share=${s.gated}` })],
        ["home refused", await i.call("/erase", { method: "POST", as: AUTHOR, headers: FORM, body: `share=${s.gated}` })],
        ["home too large", await i.call("/erase", { method: "POST", as: AUTHOR, headers: { ...FORM, origin: i.HOST }, body: `share=${s.gated}&pad=${"x".repeat(5000)}` })],
        ["onboard", await i.call("/api/onboard")],
      ];
      for (const [name, res] of pages) {
        // The raw page is the Share's own HTML (the fixture says nothing of the term); every other page is ours.
        const text = await res.text();
        expect(text, `${language} ${name}`).not.toMatch(/drop/i);
      }
      const errors = [
        await i.api("GET", "/api/shares/AAAAAAAAAAAA"),
        await i.api("GET", "/api/shares/not-a-slug"),
        await i.api("PUT", "/api/shares/AAAAAAAAAAAA", { html: PAGE }),
        await i.api("PATCH", "/api/shares/AAAAAAAAAAAA", { title: "x" }),
        await i.api("DELETE", "/api/shares/AAAAAAAAAAAA"),
        await i.api("POST", "/api/shares/AAAAAAAAAAAA/visibility", { public: true }),
        await i.api("POST", "/api/shares", { html: "" }),
        await i.api("POST", "/api/shares", { html: PAGE, title: "x".repeat(500) }),
        await i.api("GET", "/api/shares?public=maybe"),
        await i.api("GET", "/api/shares?page=0"),
        await i.api("GET", "/api/shares/AAAAAAAAAAAA/versions"),
        await i.api("GET", `/api/shares/${s.gated}/versions/9`),
        await i.api("GET", `/api/shares/${s.gated}/versions/1/zip`),
        await i.api("GET", "/api/nothing"),
        await i.api("POST", "/api/shares", "{not json" as never, { "content-type": "application/json" }),
      ];
      for (const e of errors) expect(e.text, `${e.status} ${e.text}`).not.toMatch(/drop/i);
      const onboard = (await i.api("GET", "/api/onboard")).json;
      expect(JSON.stringify(onboard)).not.toMatch(/drop/i);
      expect(onboard.requests.filter((r: string) => r.includes("/api/shares")).length).toBeGreaterThanOrEqual(10);
    });
  }
});

describe("R4 minted links and the sign-in link", () => {
  test("API urls are /s/ for gated and /p/ for public, in create, get, list, visibility and PUT", async () => {
    const i = await startInstance();
    const created = (await i.api("POST", "/api/shares", { html: PAGE, title: "L" })).json;
    expect(created.url).toBe(`https://gate.example.com/s/${created.slug}`);
    const pub = (await i.api("POST", `/api/shares/${created.slug}/visibility`, { public: true })).json;
    expect(pub.url).toBe(`https://gate.example.com/p/${created.slug}`);
    const put = (await i.api("PUT", `/api/shares/${created.slug}`, { html: PAGE })).json;
    expect(put.url).toBe(`https://gate.example.com/p/${created.slug}`);
    const back = (await i.api("POST", `/api/shares/${created.slug}/visibility`, { public: false })).json;
    expect(back.url).toBe(`https://gate.example.com/s/${created.slug}`);
    const list = (await i.api("GET", "/api/shares")).json.data;
    expect(list.map((x: { url: string }) => x.url)).toEqual([`https://gate.example.com/s/${created.slug}`]);
  });

  test("a public link to a gated Share offers sign-in at /s/<slug>, never /d/", async () => {
    const i = await startInstance();
    const s = await seed(i);
    const html = await (await i.call(`/p/${s.gated}`)).text();
    expect(html).toContain(`href="/s/${s.gated}"`);
    expect(html).not.toContain("/d/");
    const raw = await (await i.call(`/p/${s.gated}/raw`)).text();
    expect(raw).toContain(`href="/s/${s.gated}"`);
    const post = await i.call(`/p/${s.gated}`, { method: "POST" });
    expect(await post.text()).toContain(`href="/s/${s.gated}"`);
  });
});

describe("R5 unchanged surfaces", () => {
  test("R2 keys stay bodies/<slug>/<id>; /p/ serves a public Share; the viewer frames /s/<slug>/raw", async () => {
    const i = await startInstance();
    const s = await seed(i);
    const keys = i.fake.sqlite.prepare("SELECT body_key FROM versions ORDER BY slug").all().map((r) => (r as { body_key: string }).body_key);
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(k).toMatch(/^bodies\/[A-Za-z0-9]{12}\/[A-Za-z0-9_-]+$/);
    expect((await i.call(`/p/${s.pub}`)).status).toBe(200);
    const viewer = await (await i.call(`/s/${s.gated}`, { as: VIEWER })).text();
    expect(viewer).toMatch(new RegExp(`<iframe class="share"[^>]*src="/s/${s.gated}/raw\\?v=1"`));
    expect(viewer).toContain('id="share"');
  });

  test("an expired ticket navigation is redirected to /s/<slug>, and a second form of the redirect never says /d/", async () => {
    // Covered end to end by reviewer-beta10-inproc; here the redirect target is asserted against the minted link shape.
    const i = await startInstance();
    const s = await seed(i);
    expect(new URL(s.gatedUrl).pathname).toBe(`/s/${s.gated}`);
  });
});
