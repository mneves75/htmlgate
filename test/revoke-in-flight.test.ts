// A token revoked while one of its writes is still in progress must not land that write: the Worker checks the token
// before it reads the body, so each Store write re-checks at commit that the token is still live.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { VERSION_FLOOR } from "../src/store";
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

  test("a live token's empty PATCH is refused with 400 before the Share is looked up", async () => {
    const slug = (await i.api("POST", "/api/shares", { html: PAGE, title: "kept" })).json.slug as string;
    const statuses: Record<string, number> = {};
    for (const [name, target] of [["existing", slug], ["missing", "Missing00000"]] as const) {
      statuses[name] = (await i.api("PATCH", `/api/shares/${target}`, {})).status;
    }
    expect(statuses).toEqual({ existing: 400, missing: 400 });
  });

  test("a live token's held writes still land", async () => {
    const { token } = await freshToken();
    const res = await heldWrite("POST", "/api/shares", { html: PAGE, title: "on time" }, token, async () => {});
    expect(res.status).toBe(201);
    const { slug } = (await res.json()) as { slug: string };
    expect((await heldWrite("PATCH", `/api/shares/${slug}`, { title: "still on time" }, token, async () => {})).status).toBe(200);
  });
});

describe("a token revoked right after it authenticates", () => {
  /** Revokes the token inside its own lookup batch, so the request is authenticated and the token is revoked before any route runs. */
  function revokeOnAuth(on: Instance, id: string) {
    on.fake.hooks.between = (n, sql) => {
      if (n !== 1 || !sql.startsWith("UPDATE tokens SET last_used_at")) return;
      on.fake.sqlite.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ?").run(Date.now(), id);
      on.fake.hooks.between = undefined;
    };
  }

  test.each([
    ["PUT", "", { html: "<p>late</p>" }],
    ["PUT", "", {}],
    ["PATCH", "", { title: "late" }],
    ["PATCH", "", {}],
    ["POST", "/visibility", { public: true }],
    ["DELETE", "", undefined],
  ] as const)("%s %s %j answers 401 for an existing and a missing Share alike, and changes nothing", async (method, suffix, body) => {
    const slug = (await i.api("POST", "/api/shares", { html: PAGE, title: "kept" })).json.slug as string;
    const start = (await i.api("GET", `/api/shares/${slug}`)).json;
    const statuses: Record<string, number> = {};
    for (const [name, target] of [["existing", slug], ["missing", "Missing00000"]] as const) {
      const { token, id } = await freshToken();
      revokeOnAuth(i, id);
      const res = await i.call(`/api/shares/${target}${suffix}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(i.fake.hooks.between, "the token was revoked during authentication").toBeUndefined();
      statuses[name] = res.status;
    }
    expect(statuses).toEqual({ existing: 401, missing: 401 });
    const end = (await i.api("GET", `/api/shares/${slug}`)).json;
    expect({ title: end.title, public: end.public, latest: end.latest_version, changed_at: end.changed_at })
      .toEqual({ title: start.title, public: start.public, latest: start.latest_version, changed_at: start.changed_at });
  });

  test("a write that fails in storage answers 401 too, for an existing and a missing Share alike", async () => {
    const slug = (await i.api("POST", "/api/shares", { html: PAGE, title: "kept" })).json.slug as string;
    const statuses: Record<string, number> = {};
    for (const [name, target] of [["existing", slug], ["missing", "Missing00000"]] as const) {
      const { token, id } = await freshToken();
      revokeOnAuth(i, id);
      i.fake.hooks.failBucketPut = true;
      try {
        statuses[name] = (await i.call(`/api/shares/${target}`, {
          method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ html: "<p>late</p>" }),
        })).status;
      } finally {
        i.fake.hooks.failBucketPut = false;
      }
    }
    expect(statuses).toEqual({ existing: 401, missing: 401 });
  });

  test("when the token re-check itself fails, an existing and a missing Share answer the same 503", async () => {
    const slug = (await i.api("POST", "/api/shares", { html: PAGE, title: "kept" })).json.slug as string;
    const statuses: Record<string, number> = {};
    for (const [name, target] of [["existing", slug], ["missing", "Missing00000"]] as const) {
      const { token, id } = await freshToken();
      revokeOnAuth(i, id);
      i.fake.hooks.failFirst = (sql) => sql.startsWith("SELECT 1 AS n FROM tokens");
      try {
        statuses[name] = (await i.call(`/api/shares/${target}`, {
          method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ html: "<p>late</p>" }),
        })).status;
      } finally {
        i.fake.hooks.failFirst = undefined;
      }
    }
    expect(statuses).toEqual({ existing: 503, missing: 503 });
  });

  test.each([
    ["rate-limited", 429, () => { i.env.WRITE_LIMIT = { limit: async () => ({ success: false }) } as RateLimit; }, "/api/shares/Missing00000"],
    ["without a write limit", 503, () => { i.env.WRITE_LIMIT = undefined as unknown as RateLimit; }, "/api/shares/Missing00000"],
    ["on a malformed path", 404, () => {}, "/api/shares/bad"],
    ["whose rate limit check fails", 500, () => { i.env.WRITE_LIMIT = { limit: async () => { throw new Error("limiter down"); } } as RateLimit; }, "/api/shares/Missing00000"],
  ] as const)("a write %s answers %i to a live token and 401 to a revoked one", async (_, live, setUp, path) => {
    const limit = i.env.WRITE_LIMIT;
    const send = (token: string) => i.call(path, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) });
    setUp();
    try {
      expect((await send((await freshToken()).token)).status).toBe(live);
      const { token, id } = await freshToken();
      revokeOnAuth(i, id);
      expect((await send(token)).status).toBe(401);
    } finally {
      i.env.WRITE_LIMIT = limit;
    }
  });

  test("a PUT on a full Instance answers 401, not quota_exceeded", async () => {
    const full = await startInstance({ STORAGE_LIMIT_BYTES: String(VERSION_FLOOR + VERSION_FLOOR / 2) });
    const slug = (await full.api("POST", "/api/shares", { html: PAGE, title: "fills it" })).json.slug as string;
    expect((await full.api("PUT", `/api/shares/${slug}`, { html: PAGE })).status, "a live token sees the cap").toBe(507);
    const { newToken, randomHex, sha256Hex } = await import("../src/ids");
    const token = newToken();
    const id = randomHex(6);
    await full.store.createToken(id, AUTHOR, "full", await sha256Hex(token), Date.now());
    revokeOnAuth(full, id);
    const res = await full.call(`/api/shares/${slug}`, {
      method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ html: PAGE }),
    });
    expect(full.fake.hooks.between, "the token was revoked during authentication").toBeUndefined();
    expect(res.status).toBe(401);
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
    // Even if a Version outside the retention window existed, a refused addVersion must neither queue nor delete it.
    i.fake.sqlite.prepare("INSERT INTO versions (slug, n, body_key, size, created_at, token_id, kind, files) VALUES (?, ?, ?, ?, ?, ?, 'page', NULL)")
      .run(slug, -100, "bodies/out-of-window", 10, now, id);
    expect(await i.store.addVersion({ ...page, author: AUTHOR, slug, tokenId: id, now, limit: 1 << 26, expiry: { at: null, set: false } })).toBe("gone");
    expect(i.fake.sqlite.prepare("SELECT 1 FROM versions WHERE slug = ? AND n = -100").get(slug)).toBeDefined();
    expect(i.fake.sqlite.prepare("SELECT 1 FROM trash WHERE body_key = ?").get("bodies/out-of-window")).toBeUndefined();
    i.fake.sqlite.prepare("DELETE FROM versions WHERE slug = ? AND n = -100").run(slug);
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
