// Views are counted at most once a minute per network address and Share (VIEW_LIMIT), so nobody can inflate a Public
// Share's count, or drive one database write per request, by repeating an anonymous request. The address only keys
// the rate limit; nothing about a visitor is written (docs/privacy.md).
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/config";
// @ts-expect-error plain JavaScript module
import { workerConfig } from "../scripts/setup.mjs";
import { windowLimit } from "./fake-env";
import { PAGE, startInstance, stopAccess, type Instance } from "./reviewer-beta10-harness";

afterAll(stopAccess);

const views = (i: Instance, slug: string) =>
  i.fake.sqlite.prepare("SELECT COALESCE(SUM(views), 0) AS v FROM share_views WHERE slug = ?").get(slug) as { v: number };

async function publicShare(i: Instance): Promise<string> {
  const s = await i.api("POST", "/api/shares", { html: PAGE, title: "pub" });
  expect(s.status).toBe(201);
  expect((await i.api("POST", `/api/shares/${s.json.slug}/visibility`, { public: true })).status).toBe(200);
  return s.json.slug as string;
}

/** An anonymous browser navigation: no sign-in, no cookie, only what any client can send. */
const open = (i: Instance, slug: string, address: string) =>
  i.call(`/p/${slug}`, { headers: { "sec-fetch-dest": "document", "cf-connecting-ip": address } });

describe("the view limit", () => {
  test("repeated anonymous navigations from one address count once; another address counts again", async () => {
    const i = await startInstance();
    const slug = await publicShare(i);
    for (let k = 0; k < 40; k++) expect((await open(i, slug, "203.0.113.7")).status).toBe(200);
    expect(views(i, slug).v).toBe(1);
    expect((await open(i, slug, "198.51.100.4")).status).toBe(200);
    expect(views(i, slug).v).toBe(2);
  });

  test("the limit is per Share: one address opening two Shares counts both", async () => {
    const i = await startInstance();
    const a = await publicShare(i);
    const b = await publicShare(i);
    await open(i, a, "203.0.113.7");
    await open(i, b, "203.0.113.7");
    expect(views(i, a).v).toBe(1);
    expect(views(i, b).v).toBe(1);
  });

  test("IPv6 counts by /64 network, the block one subscriber holds: rotating within it counts once", async () => {
    const i = await startInstance();
    const slug = await publicShare(i);
    await open(i, slug, "2001:db8:1:2::1");
    await open(i, slug, "2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    await open(i, slug, "2001:0db8:0001:0002:0:0:0:ffff");
    expect(views(i, slug).v).toBe(1);
    await open(i, slug, "2001:db8:1:3::1");
    expect(views(i, slug).v).toBe(2);
    // IPv4 keeps the whole address: neighbours are different subscribers.
    await open(i, slug, "203.0.113.7");
    await open(i, slug, "203.0.113.8");
    expect(views(i, slug).v).toBe(4);
  });

  test("an Instance without its view limit still serves the page and counts nothing", async () => {
    const i = await startInstance();
    const slug = await publicShare(i);
    const env: Env = { ...i.env, VIEW_LIMIT: undefined };
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const res = await worker.fetch!(new Request(`${i.HOST}/p/${slug}`, { headers: { "sec-fetch-dest": "document", "cf-connecting-ip": "203.0.113.7" } }) as never, env, ctx);
    await Promise.allSettled(pending);
    expect(res.status).toBe(200);
    expect(views(i, slug).v).toBe(0);
  });

  test("the limiter refusing is not an error the reader sees", async () => {
    const i = await startInstance();
    const slug = await publicShare(i);
    const env: Env = { ...i.env, VIEW_LIMIT: windowLimit(0) as unknown as RateLimit };
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const res = await worker.fetch!(new Request(`${i.HOST}/p/${slug}`, { headers: { "sec-fetch-dest": "document", "cf-connecting-ip": "203.0.113.7" } }) as never, env, ctx);
    await Promise.allSettled(pending);
    expect(res.status).toBe(200);
    expect(views(i, slug).v).toBe(0);
  });

  test("setup's config and the local config carry the limit: one count per address and Share a minute", () => {
    const c = workerConfig({ name: "x", author: "a@b.c", allowlist: [], language: "en", expiryDays: 30 }, { uuid: "u", name: "x-db" }, { open: false, vars: {} });
    const limit = { name: "VIEW_LIMIT", namespace_id: expect.any(String), simple: { limit: 1, period: 60 } };
    expect(c.ratelimits).toContainEqual(limit);
    const local = JSON.parse(readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, ""));
    expect(local.ratelimits).toContainEqual(limit);
    // Two limits, two namespaces: sharing one would let views spend the write budget.
    const ids = c.ratelimits.map((r: { namespace_id: string }) => r.namespace_id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
