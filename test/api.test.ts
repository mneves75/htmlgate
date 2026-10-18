// The Publisher API, through the real entry point. Decisions: issues #9, #11, #13 and #14.
import { beforeAll, describe, expect, test } from "vitest";
import { api, base, mintToken, page } from "./helpers";

let call: ReturnType<typeof api>;
let token: string;
let tokenName: string;

beforeAll(async () => {
  tokenName = "laptop-" + Math.random().toString(36).slice(2, 8);
  token = await mintToken(tokenName);
  call = api(token);
});

const publish = (over: Record<string, unknown> = {}) =>
  call("POST", "/api/shares", { html: page("hello"), title: "Hello", description: "first", ...over });

describe("tokens", () => {
  test("the former collection path is not found with a valid token", async () => {
    const r = await call("GET", "/api/drops");
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("not_found");
  });

  test("a request without a token is refused with the error envelope", async () => {
    const r = await api(null)("GET", "/api/shares");
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("unauthorized");
    expect(typeof r.json.error.message).toBe("string");
  });

  test("an unknown token is refused", async () => {
    const r = await api("hg_" + "a".repeat(40))("GET", "/api/shares");
    expect(r.status).toBe(401);
  });

  test("a token is hg_ followed by letters and digits only", async () => {
    const t = await mintToken("format");
    expect(t).toMatch(/^hg_[A-Za-z0-9]{40}$/);
  });

  test("a token cannot create a token", async () => {
    const r = await call("POST", "/api/tokens", { name: "spare" });
    expect(r.status).toBe(404);
  });

  test("a token lists the Author's tokens and revokes one, which stops working on the next request", async () => {
    const victim = await mintToken("lost-laptop");
    const v = api(victim);
    expect((await v("GET", "/api/shares")).status).toBe(200);

    const list = await call("GET", "/api/tokens");
    expect(list.status).toBe(200);
    const row = list.json.data.find((t: any) => t.name === "lost-laptop");
    expect(row).toMatchObject({ id: expect.stringMatching(/^[0-9a-f]{12}$/), revoked_at: null });
    expect(typeof row.created_at).toBe("number");
    expect(row.last_used_at).not.toBeNull();
    expect(JSON.stringify(list.json)).not.toContain(victim);

    expect((await call("DELETE", `/api/tokens/${row.id}`)).status).toBe(204);
    expect((await v("GET", "/api/shares")).status).toBe(401);
  });
});

describe("shares", () => {
  test("publishing creates a gated Share at version 1 with a Viewer URL", async () => {
    const r = await publish({ metadata: { pr: "1" } });
    expect(r.status).toBe(201);
    expect(r.json.slug).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(r.json).toMatchObject({
      url: `${base}/s/${r.json.slug}`, title: "Hello", description: "first",
      public: false, latest_version: 1, metadata: { pr: "1" },
    });
    expect(typeof r.json.updated_at).toBe("number");
    expect(r.json.changed_by).toEqual({ id: expect.stringMatching(/^[0-9a-f]{12}$/), name: tokenName });
  });

  test("a token reads a Share and the HTML of a Version", async () => {
    const { json: d } = await publish({ html: page("body one") });
    const got = await call("GET", `/api/shares/${d.slug}`);
    expect(got.status).toBe(200);
    expect(got.json.slug).toBe(d.slug);
    const v = await call("GET", `/api/shares/${d.slug}/versions/1`);
    expect(v.status).toBe(200);
    expect(v.json).toMatchObject({ n: 1, html: page("body one"), size: page("body one").length });
  });

  test("API paths are matched exactly: extra segments after a Version, a Share or a list are not found", async () => {
    const { json: d } = await publish({ html: page("exact") });
    for (const p of [`/api/shares/${d.slug}/versions/1/x`, `/api/shares/${d.slug}/versions/1/`, `/api/shares/${d.slug}/versions/x`, `/api/shares/${d.slug}/x`, `/api/shares/${d.slug}/visibility/x`]) {
      expect((await call("GET", p)).status, p).toBe(404);
    }
  });

  test("PUT with HTML adds a Version at the same URL; PATCH changes fields without one", async () => {
    const { json: d } = await publish();
    const put = await call("PUT", `/api/shares/${d.slug}`, { html: page("two"), title: "Two" });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ slug: d.slug, url: d.url, latest_version: 2, title: "Two" });
    const patch = await call("PATCH", `/api/shares/${d.slug}`, { title: "Renamed", metadata: { k: "v" } });
    expect(patch.status).toBe(200);
    expect(patch.json).toMatchObject({ latest_version: 2, title: "Renamed", metadata: { k: "v" } });
    const versions = await call("GET", `/api/shares/${d.slug}/versions`);
    expect(versions.status).toBe(200);
    expect(versions.json.data.map((v: any) => v.n)).toEqual([2, 1]);
  });

  test("PATCH refuses HTML", async () => {
    const { json: d } = await publish();
    const r = await call("PATCH", `/api/shares/${d.slug}`, { html: page("x") });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("metadata_only_on_patch");
  });

  test("a Share keeps its latest 20 Versions", async () => {
    const { json: d } = await publish({ html: page("v1") });
    for (let i = 2; i <= 21; i++) {
      const r = await call("PUT", `/api/shares/${d.slug}`, { html: page("v" + i), title: "Hello" });
      expect(r.status).toBe(200);
    }
    const versions = await call("GET", `/api/shares/${d.slug}/versions`);
    expect(versions.status).toBe(200);
    expect(versions.json.data.map((v: any) => v.n)).toEqual(Array.from({ length: 20 }, (_, i) => 21 - i));
    const gone = await call("GET", `/api/shares/${d.slug}/versions/1`);
    expect(gone.status).toBe(404);
    expect(gone.json.error.code).toBe("version_not_found");
    const kept = await call("GET", `/api/shares/${d.slug}/versions/2`);
    expect(kept.status).toBe(200);
    expect(kept.json.html).toBe(page("v2"));
  });

  test("list paginates, sorts by update and filters by every given Tag", async () => {
    const tag = "run-" + Math.random().toString(36).slice(2, 8);
    const a = (await publish({ metadata: { run: tag, pr: "7" } })).json;
    const b = (await publish({ metadata: { run: tag, pr: "8" } })).json;
    const both = await call("GET", `/api/shares?page=1&pageSize=100&sortBy=updated_at&metadata.run=${tag}`);
    expect(both.status).toBe(200);
    expect(both.json.data.map((d: any) => d.slug)).toEqual([b.slug, a.slug]);
    expect(both.json.pagination).toMatchObject({ page: 1, total: 2, total_pages: 1 });
    const one = await call("GET", `/api/shares?pageSize=1&metadata.run=${tag}&metadata.pr=7`);
    expect(one.status).toBe(200);
    expect(one.json.data.map((d: any) => d.slug)).toEqual([a.slug]);
    const paged = await call("GET", `/api/shares?pageSize=1&page=2&metadata.run=${tag}`);
    expect(paged.status).toBe(200);
    expect(paged.json.data.map((d: any) => d.slug)).toEqual([a.slug]);
    expect(paged.json.pagination.total_pages).toBe(2);
  });

  test("bad input is refused with the reference's codes", async () => {
    // Each refusal is a 400 before its code is read, so a planted bug fails by assertion, not by a crash.
    const refused = async (over: Record<string, unknown>) => {
      const r = await publish(over);
      expect(r.status).toBe(400);
      return r.json.error.code;
    };
    expect(await refused({ html: undefined })).toBe("html_required");
    expect(await refused({ title: "" })).toBe("title_required");
    expect(await refused({ title: "t".repeat(201) })).toBe("title_too_long");
    expect(await refused({ description: "d".repeat(501) })).toBe("description_too_long");
    const tooMany = Object.fromEntries(Array.from({ length: 11 }, (_, i) => ["k" + i, "v"]));
    expect(await refused({ metadata: tooMany })).toBe("invalid_arg");
    expect(await refused({ metadata: { "bad key!": "v" } })).toBe("invalid_arg");
    const raw = await fetch(`${base}/api/shares`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{" });
    expect(raw.status).toBe(400);
    expect(((await raw.json()) as any).error.code).toBe("invalid_json");
  });

  test("publishing can never set the gate: public and passcode fields are refused", async () => {
    const pub = await publish({ public: true });
    expect(pub.status).toBe(400);
    expect(pub.json.error.code).toBe("invalid_arg");
    const pass = await publish({ passcode: "1234" });
    expect(pass.status).toBe(400);
    expect(pass.json.error.code).toBe("invalid_arg");
    expect(pass.json.error.message).toMatch(/visibility/);
  });

  test("a body over 2 MiB is refused; exactly 2 MiB is accepted", async () => {
    const mib = 2 * 1024 * 1024;
    const shell = page("");
    const fits = shell.replace("<p></p>", "<p>" + "x".repeat(mib - shell.length) + "</p>");
    expect(new TextEncoder().encode(fits).length).toBe(mib);
    const ok = await publish({ html: fits });
    expect(ok.status).toBe(201);
    const over = await publish({ html: fits + "x" });
    expect(over.status).toBe(413);
    expect(over.json.error.code).toBe("html_too_large");
    // Bytes, not characters: 2-byte characters count twice.
    const wide = await publish({ html: "é".repeat(mib / 2 + 1) });
    expect(wide.status).toBe(413);
    expect(wide.json.error.code).toBe("html_too_large");
  });

  test("list paging refuses numbers D1 cannot use, with the error envelope", async () => {
    for (const q of ["page=1e21", "page=0x10", "page=1.0", "pageSize=1e3", "page=0"]) {
      const r = await call("GET", `/api/shares?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.json.error.code, q).toBe("invalid_arg");
    }
  });

  test("the size cap is on the HTML's bytes, not on how long its JSON escaping is", async () => {
    const r = await publish({ html: "\u0001".repeat(600_000) });
    expect(r.status).toBe(201);
  });

  test("an unknown slug is not found", async () => {
    const r = await call("GET", "/api/shares/AAAAAAAAAAAA");
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("not_found");
  });
});

describe("the public switch", () => {
  test("only the explicit call makes a Share public, a new Version keeps it, and it can be gated again", async () => {
    const { json: d } = await publish();
    const on = await call("POST", `/api/shares/${d.slug}/visibility`, { public: true });
    expect(on.status).toBe(200);
    expect(on.json).toMatchObject({ public: true, url: `${base}/p/${d.slug}` });
    const put = await call("PUT", `/api/shares/${d.slug}`, { html: page("v2"), title: "Hello" });
    expect(put.status).toBe(200);
    expect(put.json.public).toBe(true);
    const off = await call("POST", `/api/shares/${d.slug}/visibility`, { public: false });
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ public: false, url: `${base}/s/${d.slug}` });
    const bad = await call("POST", `/api/shares/${d.slug}/visibility`, {});
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("invalid_arg");
  });

  test("list filters by state, so 'which Shares are public' is one call", async () => {
    const tag = "vis-" + Math.random().toString(36).slice(2, 8);
    const a = (await publish({ metadata: { t: tag } })).json;
    await publish({ metadata: { t: tag } });
    await call("POST", `/api/shares/${a.slug}/visibility`, { public: true });
    const r = await call("GET", `/api/shares?public=true&metadata.t=${tag}`);
    expect(r.status).toBe(200);
    expect(r.json.data.map((d: any) => d.slug)).toEqual([a.slug]);
  });
});

describe("after a token leaks", () => {
  test("each Share names the token that last changed it, and each Version the token that wrote it", async () => {
    const leaked = await mintToken("leaked");
    const thief = api(leaked);
    const { json: d } = await publish();
    await thief("POST", `/api/shares/${d.slug}/visibility`, { public: true });
    const seen = await call("GET", `/api/shares/${d.slug}`);
    expect(seen.status).toBe(200);
    expect(seen.json.changed_by.name).toBe("leaked");
    expect(typeof seen.json.changed_at).toBe("number");
    await thief("PUT", `/api/shares/${d.slug}`, { html: page("defaced"), title: "Hello" });
    const listed = await call("GET", `/api/shares/${d.slug}/versions`);
    expect(listed.status).toBe(200);
    const versions = listed.json.data;
    expect(versions[0].token).toMatchObject({ name: "leaked" });
    expect(versions[1].token).toMatchObject({ name: tokenName });
  });
});

describe("delete", () => {
  test("delete is soft and looks like a Share that never existed", async () => {
    const tag = "del-" + Math.random().toString(36).slice(2, 8);
    const { json: d } = await publish({ metadata: { t: tag } });
    const del = await call("DELETE", `/api/shares/${d.slug}`);
    expect(del.status).toBe(204);
    expect(del.text).toBe("");
    for (const [m, p] of [["GET", `/api/shares/${d.slug}`], ["GET", `/api/shares/${d.slug}/versions/1`], ["PUT", `/api/shares/${d.slug}`], ["DELETE", `/api/shares/${d.slug}`]] as const) {
      const r = await call(m, p, m === "PUT" ? { html: page("x"), title: "x" } : undefined);
      expect(r.status, `${m} ${p}`).toBe(404);
      expect(r.json.error.code).toBe("not_found");
    }
    const left = await call("GET", `/api/shares?metadata.t=${tag}`);
    expect(left.status).toBe(200);
    expect(left.json.data).toEqual([]);
  });
});

describe("discoverability", () => {
  test("/api/onboard names this Instance and holds no Share data", async () => {
    const r = await api(null)("GET", "/api/onboard");
    expect(r.status).toBe(200);
    expect(r.json.api_url).toBe(base);
    expect(r.json.token_format).toBe("hg_ followed by 40 letters and digits");
  });

  test("robots.txt disallows everything", async () => {
    const r = await fetch(`${base}/robots.txt`);
    expect(await r.text()).toBe("User-agent: *\nDisallow: /\n");
  });
});
