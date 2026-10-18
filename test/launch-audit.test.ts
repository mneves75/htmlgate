// The launch audit's fixes, through the real Worker in-process (see reviewer-beta10-harness.ts): a failure must be
// visible in the logs and must not take the next cleanup step with it; the write limit and the small-request caps
// must hold without help from the config.
import { readFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import worker from "../src/index";
import { person } from "../src/access";
import { readConfig, type Env } from "../src/config";
// @ts-expect-error plain JavaScript module
import { checkCleanTree, workerConfig } from "../scripts/setup.mjs";
import { writeZip } from "../packages/cli/src/zip";
import { AUTHOR, PAGE, startInstance, stopAccess } from "./reviewer-beta10-harness";

afterAll(stopAccess);
afterEach(() => vi.restoreAllMocks());

const logged = () => vi.spyOn(console, "error").mockImplementation(() => {});
const controller = { cron: "17 * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController;

describe("the hourly cleanup", () => {
  test("a failing purge is logged, still fails the run, and does not stop due bodies from being deleted", async () => {
    const i = await startInstance();
    i.fake.objects.set("bodies/due/1", new Uint8Array(1));
    i.fake.sqlite.prepare("INSERT INTO trash (body_key, size, due_at) VALUES (?, ?, ?)").run("bodies/due/1", 1, 0);
    const errors = logged();
    const broken = { ...i.env, DB: { prepare: i.fake.db.prepare.bind(i.fake.db), batch: async () => { throw new Error("d1 down"); } } as unknown as D1Database };

    await expect(worker.scheduled!(controller, broken)).rejects.toThrow("d1 down");

    expect(i.fake.objects.has("bodies/due/1")).toBe(false);
    expect(errors.mock.calls.map((c) => c.slice(0, 2))).toContainEqual(["scheduled", "expire"]);
  });

  test("a failing trash step is logged too", async () => {
    const i = await startInstance();
    i.fake.objects.set("bodies/due/1", new Uint8Array(1));
    i.fake.sqlite.prepare("INSERT INTO trash (body_key, size, due_at) VALUES (?, ?, ?)").run("bodies/due/1", 1, 0);
    i.fake.hooks.failBucketDelete = true;
    const errors = logged();

    await expect(worker.scheduled!(controller, i.env)).rejects.toThrow("bucket unavailable");

    expect(errors.mock.calls.map((c) => c.slice(0, 2))).toContainEqual(["scheduled", "trash"]);
  });
});

describe("a sign-in that cannot be verified", () => {
  const request = (token: string) => new Request("https://gate.example.com/", { headers: { "cf-access-jwt-assertion": token } });

  test("an unreachable certs endpoint is logged, without the token, and still signs nobody in", async () => {
    const i = await startInstance();
    const token = await i.jwt(AUTHOR);
    const cfg = readConfig({ ...i.env, ACCESS_TEAM_URL: "http://127.0.0.1:9" })!;
    const errors = logged();

    expect(await person(request(token), cfg)).toBeNull();

    expect(errors.mock.calls.length).toBe(1);
    expect(errors.mock.calls[0]![0]).toBe("access");
    expect(JSON.stringify(errors.mock.calls)).not.toContain(token);
  });

  test("a forged or malformed token is an ordinary refusal and logs nothing", async () => {
    const i = await startInstance();
    const cfg = readConfig(i.env)!;
    const good = await i.jwt(AUTHOR);
    const forged = good.slice(0, good.lastIndexOf(".") + 1) + "A".repeat(342);
    const errors = logged();

    expect(await person(request("not-a-jwt"), cfg)).toBeNull();
    expect(await person(request(forged), cfg)).toBeNull();
    expect(await person(request(await i.jwt(AUTHOR, { aud: "another-app" })), cfg)).toBeNull();
    expect(await person(request(good), cfg)).toBe(AUTHOR);

    expect(errors).not.toHaveBeenCalled();
  });
});

describe("the write limit", () => {
  test("an Instance without its rate limit refuses changes instead of taking them unlimited, and still reads", async () => {
    const i = await startInstance();
    const env: Env = { ...i.env, WRITE_LIMIT: undefined };
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const headers = { authorization: `Bearer ${i.token}`, "content-type": "application/json" };

    const write = await worker.fetch!(new Request(`${i.HOST}/api/shares`, { method: "POST", headers, body: JSON.stringify({ html: PAGE, title: "t" }) }) as never, env, ctx);
    expect(write.status).toBe(503);
    expect(((await write.json()) as { error: { code: string } }).error.code).toBe("server_misconfigured");
    expect(i.fake.one<{ n: number }>("SELECT COUNT(*) AS n FROM shares").n).toBe(0);

    expect((await worker.fetch!(new Request(`${i.HOST}/api/shares`, { headers }) as never, env, ctx)).status).toBe(200);
  });

  test("the config setup generates carries the limit", () => {
    const c = workerConfig({ name: "x", author: "a@b.c", allowlist: [], language: "en", expiryDays: 30 }, { uuid: "u", name: "x-db" }, { open: false, vars: {} });
    expect(c.ratelimits).toEqual([{ name: "WRITE_LIMIT", namespace_id: expect.any(String), simple: { limit: 60, period: 60 } }]);
  });
});

describe("requests that carry only fields", () => {
  test("PATCH and visibility refuse a body over 64 KiB, and take one just under", async () => {
    const i = await startInstance();
    const slug = (await i.api("POST", "/api/shares", { html: PAGE, title: "t" })).json.slug as string;
    const big = { title: "t", description: "x".repeat(70 * 1024) };

    const patched = await i.api("PATCH", `/api/shares/${slug}`, big);
    expect(patched.status).toBe(413);
    expect(patched.json.error.code).toBe("body_too_large");
    const seen = await i.api("POST", `/api/shares/${slug}/visibility`, { public: true, pad: "x".repeat(70 * 1024) });
    expect(seen.status).toBe(413);
    expect((await i.api("GET", `/api/shares/${slug}`)).json.public).toBe(false);

    expect((await i.api("PATCH", `/api/shares/${slug}`, { title: "renamed" })).status).toBe(200);
  });

  test("a new Version for a Share that does not exist is refused before its body is read", async () => {
    const i = await startInstance();
    const r = await i.api("PUT", "/api/shares/AAAAAAAAAAAA", new TextEncoder().encode("not a zip"), i.zipHeaders);
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("not_found");
  });
});

describe("a body the bucket lost", () => {
  test("the zip download answers 404 and says so in the logs", async () => {
    const i = await startInstance();
    const zip = writeZip([{ path: "index.html", data: new TextEncoder().encode(PAGE) }]);
    const slug = (await i.api("POST", "/api/shares?title=Site", zip, i.zipHeaders)).json.slug as string;
    expect((await i.api("GET", `/api/shares/${slug}/versions/1/zip`)).status).toBe(200);
    i.fake.objects.clear();
    const errors = logged();

    const r = await i.api("GET", `/api/shares/${slug}/versions/1/zip`);

    expect(r.status).toBe(404);
    expect(errors.mock.calls.some((c) => c[0] === "missing body")).toBe(true);
  });
});

describe("deploying only what is committed", () => {
  const git = (out: string) => () => out;

  test("setup and the landing deploy refuse a tree with uncommitted source", () => {
    expect(() => checkCleanTree(git(" M src/access.ts\n"))).toThrow(/src\/access\.ts/);
    expect(() => checkCleanTree(git("?? site/public/new.html\n"))).toThrow(/uncommitted/);
    expect(() => checkCleanTree(git(""))).not.toThrow();
  });

  test("both deploy commands run the check before anything else", () => {
    for (const file of ["scripts/setup.mjs", "scripts/site-deploy.mjs"]) {
      const main = readFileSync(file, "utf8").split("async function main() {")[1]!;
      expect(main.indexOf("checkCleanTree();"), file).toBeGreaterThan(-1);
      expect(main.indexOf("checkCleanTree();"), file).toBeLessThan(main.indexOf("checkSameAccount("));
    }
  });
});
