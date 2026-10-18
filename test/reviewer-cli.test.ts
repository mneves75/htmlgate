// Reviewer tests: the CLI beyond the happy path, and that the CLI can never move the gate on its own.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { VIEWER } from "./global-setup";
import { accessJwt, api, base, htmlgate as run, mintToken, page } from "./helpers";
import { get, jwtHeader } from "./reviewer-helpers";

let dir: string;
let call: ReturnType<typeof api>;
let token: string;

const htmlgate = (...args: string[]) => run(dir, { HOME: dir, HTMLGATE_URL: base, HTMLGATE_TOKEN: token }, args);

beforeAll(async () => {
  token = await mintToken("reviewer-cli");
  call = api(token);
  dir = mkdtempSync(join(tmpdir(), "htmlgate-rcli-"));
  writeFileSync(join(dir, "a.html"), page("alpha"));
  writeFileSync(join(dir, "b.html"), page("beta"));
});

describe("the CLI's other requests", () => {
  test("publish --slug, --description, update --description, --metadata replace, --clear-metadata", async () => {
    const pub = await htmlgate("publish", "a.html", "--title", "First", "--description", "desc one", "--metadata", "k=v", "--metadata", "z=1");
    expect(pub.code, pub.stderr).toBe(0);
    const slug: string = pub.out.slug;
    expect((await call("GET", `/api/shares/${slug}`)).json).toMatchObject({ description: "desc one", metadata: { k: "v", z: "1" } });

    const again = await htmlgate("publish", "b.html", "--slug", slug, "--title", "Second");
    expect(again.code, again.stderr).toBe(0);
    expect(again.out.slug).toBe(slug);
    expect((await call("GET", `/api/shares/${slug}`)).json).toMatchObject({ title: "Second", latest_version: 2 });
    expect((await call("GET", `/api/shares/${slug}/versions/2`)).json.html).toBe(page("beta"));

    expect((await htmlgate("update", slug, "--description", "desc two")).code).toBe(0);
    expect((await call("GET", `/api/shares/${slug}`)).json).toMatchObject({ description: "desc two", latest_version: 2 });
    expect((await htmlgate("update", slug, "--metadata", "only=this")).code).toBe(0);
    expect((await call("GET", `/api/shares/${slug}`)).json.metadata).toEqual({ only: "this" });
    expect((await htmlgate("update", slug, "--clear-metadata")).code).toBe(0);
    expect((await call("GET", `/api/shares/${slug}`)).json.metadata).toEqual({});
  });

  test("list --limit and --metadata filter; --slug with --upsert is refused by the CLI itself", async () => {
    const t = "rl-" + Math.random().toString(36).slice(2, 8);
    for (const n of [1, 2, 3]) expect((await htmlgate("publish", "a.html", "--title", `L${n}`, "--metadata", `t=${t}`, "--metadata", `n=${n}`)).code).toBe(0);
    const all = await htmlgate("list", "--metadata", `t=${t}`);
    expect(JSON.stringify(all.out).match(/"slug"/g)?.length).toBe(3);
    const two = await htmlgate("list", "--metadata", `t=${t}`, "-n", "2");
    expect(JSON.stringify(two.out).match(/"slug"/g)?.length).toBe(2);
    const one = await htmlgate("list", "--metadata", `t=${t}`, "--metadata", "n=2");
    expect(JSON.stringify(one.out).match(/"slug"/g)?.length).toBe(1);
    expect((await htmlgate("publish", "a.html", "--slug", "AAAAAAAAAAAA", "--upsert", "--metadata", "a=b")).code).toBe(7);
  });

  test("a deleted Share is gone for the CLI: update and url exit 4, upsert publishes a fresh Share", async () => {
    const t = "rd-" + Math.random().toString(36).slice(2, 8);
    const first = await htmlgate("publish", "a.html", "--title", "D", "--upsert", "--metadata", `t=${t}`);
    const slug: string = first.out.slug;
    expect((await htmlgate("delete", slug)).code).toBe(0);
    expect((await htmlgate("delete", slug)).code).toBe(4);
    expect((await htmlgate("url", slug)).code).toBe(4);
    expect((await htmlgate("update", slug, "--title", "x")).code).toBe(4);
    expect((await htmlgate("publish", "a.html", "--slug", slug)).code).toBe(4);
    const fresh = await htmlgate("publish", "a.html", "--title", "D", "--upsert", "--metadata", `t=${t}`);
    expect(fresh.code, fresh.stderr).toBe(0);
    expect(fresh.out.slug).not.toBe(slug);
    expect((await get(`/p/${slug}`)).status).toBe(404);
  });

  test("a revoked token makes every CLI command exit 2", async () => {
    const other = api(await mintToken("reviewer-cli-other"));
    const id = (await other("GET", "/api/tokens")).json.data.find((x: any) => x.name === "reviewer-cli").id as string;
    await other("DELETE", `/api/tokens/${id}`);
    for (const args of [["list"], ["publish", "a.html", "--title", "x"], ["url", "AAAAAAAAAAAA"], ["update", "AAAAAAAAAAAA", "--title", "x"], ["delete", "AAAAAAAAAAAA"]]) {
      expect((await htmlgate(...args)).code, args.join(" ")).toBe(2);
    }
    token = await mintToken("reviewer-cli"); // restore for any later test
    call = api(token);
  });
});

describe("only public and gate move the gate", () => {
  test("a Share published, updated, upserted and patched by the CLI stays gated; a Public Share stays public; and the CLI's URL opens only as the gate says", async () => {
    const t = "rg-" + Math.random().toString(36).slice(2, 8);
    const pub = await htmlgate("publish", "a.html", "--title", "G", "--upsert", "--metadata", `t=${t}`);
    const slug: string = pub.out.slug;
    expect(pub.out.url).toBe(`${base}/s/${slug}`);
    await htmlgate("publish", "b.html", "--title", "G", "--upsert", "--metadata", `t=${t}`);
    await htmlgate("update", slug, "--file", "a.html");
    await htmlgate("update", slug, "--title", "G2");
    expect((await call("GET", `/api/shares/${slug}`)).json).toMatchObject({ public: false, latest_version: 3 });
    expect((await get(`/p/${slug}`)).status).toBe(404);
    // The CLI's URL, opened by an allowlisted person and by a stranger.
    const path = new URL(pub.out.url).pathname;
    expect((await get(path, jwtHeader(await accessJwt(VIEWER)))).status).toBe(200);
    expect((await get(path)).status).toBe(404);
    expect((await get(path, jwtHeader(await accessJwt("outsider@example.com")))).status).toBe(404);

    // Make it public through the API; CLI updates keep it public, and `url` reports the public address.
    expect((await call("POST", `/api/shares/${slug}/visibility`, { public: true })).status).toBe(200);
    await htmlgate("update", slug, "--file", "b.html");
    await htmlgate("publish", "a.html", "--title", "G", "--upsert", "--metadata", `t=${t}`);
    expect((await call("GET", `/api/shares/${slug}`)).json.public).toBe(true);
    expect(JSON.stringify((await htmlgate("url", slug)).out)).toContain(`${base}/p/${slug}`);
    expect((await get(`/p/${slug}/raw`)).body).toBe(page("alpha"));
    // And a brand-new Share with the same Tags starts gated even though its sibling is public.
    await htmlgate("delete", slug);
    const next = await htmlgate("publish", "a.html", "--title", "G", "--upsert", "--metadata", `t=${t}`);
    expect(next.out.url).toBe(`${base}/s/${next.out.slug}`);
  });
});
