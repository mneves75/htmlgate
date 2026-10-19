// The metrics report: a snapshot that `metrics:sync` writes with the Author's token, shown as an HTML table on the
// Instance's own /metrics page, for the Author only. The counts themselves live in Workers Analytics Engine, which a
// Worker can write and cannot read, so what this tests is the snapshot's path and the page that renders it.
import { describe, expect, inject, test } from "vitest";
import { AUTHOR, settings, startInstance } from "./global-setup";
import { asPerson, api, base, mintToken } from "./helpers";

// The Author's Allowlist in the tests holds AUTHOR and VIEWER@EXAMPLE.COM.
const VIEWER = "viewer@example.com";
const teamUrl = inject("teamUrl");
const rows = [
  { page: "/", views: 5, last_seen: 1792380000000 },
  { page: "/en/", views: 1, last_seen: 1792370000000 },
  { page: "404", views: 2, last_seen: 1792360000000 },
];

describe("the metrics snapshot", () => {
  test("a token stores it, and the Author reads it as a table with a link per page", async () => {
    const call = api(await mintToken("metrics"));
    const stored = await call("PUT", "/api/metrics", { origin: "https://htmlgate.com", generated_at: 1792390000000, pages: rows });
    expect(stored.status).toBe(200);
    expect(stored.json).toEqual({ origin: "https://htmlgate.com", generated_at: 1792390000000, pages: 3 });

    const res = await fetch(`${base}/metrics`, await asPerson(AUTHOR));
    expect(res.status).toBe(200);
    const html = await res.text();
    // One row per page: the path links to that page, and the count is its own cell.
    expect(html).toContain('<a href="https://htmlgate.com/" rel="noopener">/</a>');
    expect(html).toContain('<a href="https://htmlgate.com/en/" rel="noopener">/en/</a>');
    expect(html).toMatch(/<span class="m-views">[^<]*<span class="lbl">Views <\/span>5<\/span>/);
    expect(html).toMatch(/<span class="m-views">[^<]*<span class="lbl">Views <\/span>1<\/span>/);
    // "404" is the counter's bucket for a page that does not exist: no link, and no button to open it.
    expect(html).toContain('<span class="m-page">404</span>');
    expect(html).not.toContain('href="https://htmlgate.com/404"');
    // A button per page that can be opened.
    expect(html.match(/class="button quiet" href="https:\/\/htmlgate\.com\//g) ?? []).toHaveLength(2);
    expect(html).toContain("Read ");
    expect(html).toContain("https://htmlgate.com");
  });

  test("a second sync replaces the snapshot instead of adding to it", async () => {
    const call = api(await mintToken("metrics-replace"));
    await call("PUT", "/api/metrics", { origin: "https://htmlgate.com", generated_at: 1792390000000, pages: rows });
    await call("PUT", "/api/metrics", { origin: "https://example.test", generated_at: 1792400000000, pages: [{ page: "/only/", views: 9, last_seen: 1792399000000 }] });
    const html = await (await fetch(`${base}/metrics`, await asPerson(AUTHOR))).text();
    expect(html).toContain('<a href="https://example.test/only/" rel="noopener">/only/</a>');
    expect(html).not.toContain('href="https://htmlgate.com/"');
  });

  test("before any sync the page says so, and points at the command", async () => {
    // A fresh Instance has no snapshot: the other tests store one on the shared Instance.
    const fresh = await startInstance(settings(teamUrl));
    try {
      const html = await (await fetch(`${fresh.base}/metrics`, await asPerson(AUTHOR))).text();
      expect(html).toContain("pnpm run metrics:sync");
      expect(html).toContain("Nothing synced yet");
      expect(html).not.toContain('class="metrics-row"');
    } finally {
      await fresh.stop();
    }
  });

  test("a Viewer gets the not-found page, not the numbers", async () => {
    const res = await fetch(`${base}/metrics`, await asPerson(VIEWER));
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).not.toContain("Views");
  });

  test("a signed-out request never reaches the page", async () => {
    // Behind Cloudflare Access the request never arrives; when it does reach the Worker unsigned, it is a not-found.
    const res = await fetch(`${base}/metrics`, { redirect: "manual" });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("Views");
  });
});

describe("what a snapshot may carry", () => {
  test.each([
    ["a page that is not a path", { page: "https://evil.example/", views: 1, last_seen: 1 }],
    ["a page with a query", { page: "/a?b=1", views: 1, last_seen: 1 }],
    ["a page with a control character", { page: "/a\nb", views: 1, last_seen: 1 }],
    ["a negative count", { page: "/", views: -1, last_seen: 1 }],
    ["a fractional count", { page: "/", views: 1.5, last_seen: 1 }],
    ["a missing last_seen", { page: "/", views: 1 }],
  ] as const)("refuses %s", async (_name, row) => {
    const call = api(await mintToken("metrics-bad"));
    const r = await call("PUT", "/api/metrics", { origin: "https://htmlgate.com", generated_at: 1792390000000, pages: [row] });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("invalid_arg");
  });

  test.each([
    ["a non-http origin", { origin: "javascript:alert(1)", generated_at: 1, pages: [] }],
    ["no origin", { generated_at: 1, pages: [] }],
    ["a bad generated_at", { origin: "https://htmlgate.com", generated_at: 0, pages: [] }],
    ["pages that are not an array", { origin: "https://htmlgate.com", generated_at: 1, pages: {} }],
  ])("refuses %s", async (_name, body) => {
    const call = api(await mintToken("metrics-bad-2"));
    const r = await call("PUT", "/api/metrics", body);
    expect(r.status).toBe(400);
  });

  test("refuses more than 500 rows", async () => {
    const call = api(await mintToken("metrics-big"));
    const many = Array.from({ length: 501 }, (_, i) => ({ page: `/p${i}`, views: 1, last_seen: 1 }));
    const r = await call("PUT", "/api/metrics", { origin: "https://htmlgate.com", generated_at: 1, pages: many });
    expect(r.status).toBe(400);
  });

  test("needs a token", async () => {
    const r = await api(null)("PUT", "/api/metrics", { origin: "https://htmlgate.com", generated_at: 1, pages: [] });
    expect(r.status).toBe(401);
  });
});
