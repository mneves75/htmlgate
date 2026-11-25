// A token revoked while one of its writes is still in progress must not land that write: the Worker checks the token
// before it reads the body, so each Store write re-checks at commit that the token is still live.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AUTHOR, PAGE, startInstance, stopAccess, type Instance } from "./reviewer-beta10-harness";

let i: Instance;
beforeAll(async () => { i = await startInstance(); });
afterAll(stopAccess);

/** Sends a write whose body arrives only after `during` has run, once the Worker has begun reading it. */
async function heldWrite(method: string, path: string, body: unknown, token: string, during: () => Promise<void>) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  let started!: () => void;
  const reading = new Promise<void>((r) => (started = r));
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      started();
      await released;
      c.enqueue(bytes);
      c.close();
    },
  }, { highWaterMark: 0 }); // pull only when the Worker reads, after it has checked the token
  const res = i.call(path, {
    method, body: stream, duplex: "half",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  } as RequestInit);
  await reading;
  await during();
  release();
  return res;
}

/** A fresh token, and a way to revoke it as the Author's /tokens page or the Operator would. */
async function freshToken() {
  const { newToken, randomHex, sha256Hex } = await import("../src/ids");
  const token = newToken();
  const id = randomHex(6);
  await i.store.createToken(id, AUTHOR, "in-flight", await sha256Hex(token), Date.now());
  return { token, id, revoke: async () => void (await i.store.revokeToken(AUTHOR, id, Date.now())) };
}

describe("a write in flight when its token is revoked", () => {
  test("publishing a new Share is refused and leaves no Share behind", async () => {
    const before = (await i.api("GET", "/api/shares")).json.pagination.total as number;
    const { token, revoke } = await freshToken();
    const res = await heldWrite("POST", "/api/shares", { html: PAGE, title: "late" }, token, revoke);
    expect(res.status).toBe(401);
    expect((await i.api("GET", "/api/shares")).json.pagination.total).toBe(before);
  });

  test.each([
    ["PUT", "", { html: "<p>late</p>" }],
    ["PATCH", "", { title: "late" }],
    ["POST", "/visibility", { public: true }],
  ] as const)("%s %s on a Share is refused and changes nothing", async (method, suffix, body) => {
    const slug = (await i.api("POST", "/api/shares", { html: PAGE, title: "kept" })).json.slug as string;
    const start = (await i.api("GET", `/api/shares/${slug}`)).json;
    const { token, revoke } = await freshToken();
    const res = await heldWrite(method, `/api/shares/${slug}${suffix}`, body, token, revoke);
    expect(res.status).toBe(401);
    const end = (await i.api("GET", `/api/shares/${slug}`)).json;
    expect({ title: end.title, public: end.public, latest: end.latest_version, changed_at: end.changed_at })
      .toEqual({ title: start.title, public: start.public, latest: start.latest_version, changed_at: start.changed_at });
  });

  test.each([
    ["PATCH", "", { title: "late" }],
    ["POST", "/visibility", { public: true }],
  ] as const)("%s %s on a missing Share answers 401 too, so a revoked token learns nothing about which Shares exist", async (method, suffix, body) => {
    const { token, revoke } = await freshToken();
    const res = await heldWrite(method, `/api/shares/Missing00000${suffix}`, body, token, revoke);
    expect(res.status).toBe(401);
  });

  test("an empty PATCH answers the same for an existing and a missing Share", async () => {
    const slug = (await i.api("POST", "/api/shares", { html: PAGE, title: "kept" })).json.slug as string;
    const statuses: Record<string, number> = {};
    for (const [name, target] of [["existing", slug], ["missing", "Missing00000"]] as const) {
      const { token, revoke } = await freshToken();
      statuses[name] = (await heldWrite("PATCH", `/api/shares/${target}`, {}, token, revoke)).status;
    }
    expect(statuses.existing).toBe(statuses.missing);
  });

  test("a live token's held writes still land", async () => {
    const { token } = await freshToken();
    const res = await heldWrite("POST", "/api/shares", { html: PAGE, title: "on time" }, token, async () => {});
    expect(res.status).toBe(201);
    const { slug } = (await res.json()) as { slug: string };
    expect((await heldWrite("PATCH", `/api/shares/${slug}`, { title: "still on time" }, token, async () => {})).status).toBe(200);
  });
});

describe("the Store refuses every write from a revoked token", () => {
  test("delete, field and visibility changes and a new Version change nothing once the token is revoked", async () => {
    const slug = (await i.api("POST", "/api/shares", { html: PAGE, title: "store" })).json.slug as string;
    const { id, revoke } = await freshToken();
    await revoke();
    const now = Date.now();
    expect(await i.store.deleteShare(AUTHOR, slug, id, now)).toBe(false);
    expect(await i.store.updateFields(AUTHOR, slug, { title: "late" }, id, now)).toBe(false);
    expect(await i.store.setPublic(AUTHOR, slug, true, id, now)).toBe(false);
    const page = { body: PAGE, kind: "page" as const, files: null, size: PAGE.length };
    expect(await i.store.addVersion({ ...page, author: AUTHOR, slug, tokenId: id, now, limit: 1 << 26, expiry: { at: null, set: false } })).toBe("gone");
    const end = (await i.api("GET", `/api/shares/${slug}`)).json;
    expect({ title: end.title, public: end.public, latest: end.latest_version }).toEqual({ title: "store", public: false, latest: 1 });
  });

  test("a revoked token cannot revoke another token, while a live one can, itself included", async () => {
    const caller = await freshToken();
    const other = await freshToken();
    await caller.revoke();
    const now = Date.now();
    expect(await i.store.revokeToken(AUTHOR, other.id, now, caller.id)).toBe(false);
    expect(await i.store.tokenLive(other.id)).toBe(true);
    expect(await i.store.revokeToken(AUTHOR, other.id, now, other.id)).toBe(true);
    expect(await i.store.tokenLive(other.id)).toBe(false);
  });
});
