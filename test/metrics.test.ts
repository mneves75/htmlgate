// Views per Share: counted on the server from the request a browser already sends, shown to the Author on the home and
// on /metrics. No cookie, no script, no visitor: a row per Share and UTC day says how often, never by whom.
import { describe, expect, test } from "vitest";
import { AUTHOR } from "./global-setup";
import { asPerson, api, base, mintToken } from "./helpers";

const VIEWER = "viewer@example.com";

/** A browser navigation, which is what counts: the request a person makes by opening the link. */
const navigate = async (path: string, email = AUTHOR) =>
  await fetch(`${base}${path}`, await asPerson(email, { headers: { "sec-fetch-dest": "document" } }));

/** The count is written in the background, so a read straight after the page may arrive first. */
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 4000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > until) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Publishes a Share with the given token and returns its slug. */
async function publish(call: ReturnType<typeof api>, title: string): Promise<string> {
  const { json } = await call("POST", "/api/shares", { html: "<!doctype html><title>t</title><h1>Hi</h1>", title });
  return json.slug as string;
}

/** What /metrics says about one Share: its row in the table, or "" when it has none. */
async function metricsRow(title: string): Promise<string> {
  const html = await (await navigate("/metrics")).text();
  return html.split("<li class=\"metrics-row\">").find((row) => row.includes(title)) ?? "";
}

describe("views per Share", () => {
  test("a browser opening the Share's page counts once, and the Author sees it on /metrics and on the home", async () => {
    const call = api(await mintToken("views"));
    const slug = await publish(call, "Counted share");

    expect((await navigate(`/s/${slug}`)).status).toBe(200);
    const row = await eventually(() => metricsRow("Counted share"), (r) => r.includes("30 days"));
    expect(row, "the Share's row on /metrics").toContain("30 days");
    expect(row).toContain("All time");
    expect(row).toContain(`href="/s/${slug}"`);

    const home = await (await navigate("/")).text();
    expect(home).toContain(`<span class="c-views">`);
    expect(home).toContain("30 days");
  });

  test("the raw bytes, a prefetch and a missing Share are not views", async () => {
    const call = api(await mintToken("views-not"));
    const slug = await publish(call, "Never opened");
    // Raw bytes, a prefetch, and a Share that does not exist.
    await navigate(`/s/${slug}/raw`);
    await fetch(`${base}/s/${slug}`, await asPerson(AUTHOR, { headers: { "sec-fetch-dest": "document", "sec-purpose": "prefetch" } }));
    await navigate(`/s/ZZZZZZZZZZZZ`);
    // Nothing above counted, so the row still shows its zero state rather than a number.
    const row = await metricsRow("Never opened");
    expect(row).not.toContain("30 days");
  });

  test("a Public Share's page counts too, and its row is the same", async () => {
    const call = api(await mintToken("views-public"));
    const slug = await publish(call, "Public counted");
    await call("POST", `/api/shares/${slug}/visibility`, { public: true });
    expect((await navigate(`/p/${slug}`)).status).toBe(200);
    const row = await eventually(() => metricsRow("Public counted"), (r) => r.includes("30 days"));
    expect(row).toContain("30 days");
  });

  test("erasing a Share erases its counts", async () => {
    const call = api(await mintToken("views-erase"));
    const slug = await publish(call, "Erased share");
    await navigate(`/s/${slug}`);
    await eventually(() => metricsRow("Erased share"), (r) => r.includes("30 days"));
    const erasing = await fetch(`${base}/erase`, {
      ...(await asPerson(AUTHOR, { headers: { "content-type": "application/x-www-form-urlencoded", origin: base } })),
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ share: slug, confirm: "1" }).toString(),
    });
    expect(erasing.status).toBe(303);
    expect(await metricsRow("Erased share")).toBe("");
  });

  test("a Viewer gets the not-found page, and a signed-out request too", async () => {
    const viewer = await navigate("/metrics", VIEWER);
    expect(viewer.status).toBe(404);
    expect(await viewer.text()).not.toContain("30 days");

    const signedOut = await fetch(`${base}/metrics`, { redirect: "manual" });
    expect(signedOut.status).toBe(404);
  });
});
