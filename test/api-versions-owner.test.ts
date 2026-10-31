// GET /api/shares/:slug/versions answers only for the Author's own live Share. Its Share check now runs alongside the
// versions read (docs/perf/PLAN.md W3); a Share of another author, a deleted or expired one, or none stays a 404 even
// though the versions read itself does not filter by author.
import { afterAll, describe, expect, test } from "vitest";
import { AUTHOR, PAGE, startInstance, stopAccess } from "./reviewer-beta10-harness";

afterAll(async () => {
  await stopAccess();
});

describe("versions of a Share", () => {
  test("only the Author's own live Share lists its Versions", async () => {
    const i = await startInstance();
    const own = await i.api("POST", "/api/shares", { html: PAGE, title: "Own" });
    expect(own.status).toBe(201);
    const ok = await i.api("GET", `/api/shares/${own.json.slug}/versions`);
    expect(ok.status).toBe(200);
    expect(ok.json.data.map((v: any) => v.n)).toEqual([1]);

    const now = Date.now();
    const share = i.fake.sqlite.prepare(`INSERT INTO shares (slug, author, title, description, tags, public, latest_version, created_at, updated_at,
      changed_by, changed_at, deleted_at, expires_at, expiry_set) VALUES (?, ?, 't', NULL, '{}', 0, 1, ?, ?, 'tok', ?, ?, ?, 0)`);
    const version = i.fake.sqlite.prepare("INSERT INTO versions (slug, n, body_key, size, created_at, token_id, kind, files) VALUES (?, 1, ?, 1, ?, 'tok', 'page', NULL)");
    const cases: [string, string, number | null, number | null][] = [
      ["foreign00001", "other@example.com", null, null],
      ["deleted00001", AUTHOR, now - 1, null],
      ["expired00001", AUTHOR, null, now - 1],
    ];
    for (const [slug, author, deleted, expires] of cases) {
      share.run(slug, author, now, now, now, deleted, expires);
      version.run(slug, `key-${slug}`, now);
    }
    for (const slug of [...cases.map((c) => c[0]), "missing00001"]) {
      const r = await i.api("GET", `/api/shares/${slug}/versions`);
      expect({ slug, status: r.status, code: r.json?.error?.code }).toEqual({ slug, status: 404, code: "not_found" });
      expect(r.text).not.toContain(`key-${slug}`);
    }
  });
});
