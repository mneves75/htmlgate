// The card a shared link unfurls to. X and WhatsApp read it from the HTML before any script, and they fetch the page
// without a session: so it exists on a Public Share's page, which Cloudflare Access lets through, and not on a Gated
// one, which stays behind the gate. The image is the Instance's own poster, served from a path Access marks public.
import { describe, expect, test } from "vitest";
// @ts-expect-error plain JavaScript module
import { accessApp } from "../scripts/setup.mjs";
import { asPerson, api, base, mintToken } from "./helpers";

const CRAWLERS = ["Twitterbot/1.0", "WhatsApp/2.23.20.0", "facebookexternalhit/1.1"];

/** The value of the single `attr="name" content="..."` element in a page, or null when it is absent or repeated. */
function meta(html: string, attr: "property" | "name", key: string): string | null {
  const all = [...html.matchAll(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`, "g"))];
  return all.length === 1 ? all[0]![1]! : null;
}

/** Publishes a Share with the given token and makes it public when asked. */
async function share(title: string, isPublic: boolean, description?: string): Promise<{ slug: string; token: string }> {
  const token = await mintToken("card");
  const call = api(token);
  const { json } = await call("POST", "/api/shares", { html: "<!doctype html><title>t</title><h1>Card</h1>", title, ...(description ? { description } : {}) });
  if (isPublic) await call("POST", `/api/shares/${json.slug}/visibility`, { public: true });
  return { slug: json.slug as string, token };
}

describe("a Public Share's link unfurls", () => {
  test.each(CRAWLERS)("%s reads a large-image card from the public page", async (ua) => {
    const { slug } = await share("Quarterly numbers", true, "Revenue, costs and the three surprises.");
    const res = await fetch(`${base}/p/${slug}`, { headers: { "user-agent": ua } });
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(meta(html, "name", "twitter:card"), "one large-image card").toBe("summary_large_image");
    expect(meta(html, "property", "og:title")).toBe("Quarterly numbers");
    expect(meta(html, "property", "og:description")).toBe("Revenue, costs and the three surprises.");
    // Absolute, on this Instance, and the same image for X and for the Open Graph consumers.
    expect(meta(html, "property", "og:image")).toBe(`${base}/og.jpg`);
    expect(meta(html, "name", "twitter:image")).toBe(`${base}/og.jpg`);
    expect(meta(html, "property", "og:image:type")).toBe("image/jpeg");
    expect(meta(html, "property", "og:image:width")).toBe("1600");
    expect(meta(html, "property", "og:image:height")).toBe("900");
    expect(meta(html, "property", "og:image:alt"), "the poster is described").toBeTruthy();
    // The card's URL is the one a crawler was given, and it is the public path.
    expect(meta(html, "property", "og:url")).toBe(`${base}/p/${slug}`);
    // A card is not an invitation to index the page in a search engine.
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  });

  test("a title with markup is escaped in the card, not rendered", async () => {
    const { slug } = await share('Report <img src=x onerror="alert(1)"> & co', true);
    const html = await (await fetch(`${base}/p/${slug}`)).text();
    expect(meta(html, "property", "og:title")).toBe("Report &lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; co");
    expect(html).not.toContain("<img src=x");
  });

  test("a Share with no description carries the Instance's own wording", async () => {
    const { slug } = await share("No description", true);
    const html = await (await fetch(`${base}/p/${slug}`)).text();
    const lead = meta(html, "property", "og:description");
    expect(lead).toBeTruthy();
    expect(lead).toContain("htmlgate");
  });
});

describe("a Gated Share's link stays bare", () => {
  test("the gated page carries no card at all", async () => {
    const { slug } = await share("Private numbers", false, "Should never be cached by anyone.");
    const html = await (await fetch(`${base}/s/${slug}`, await asPerson("author@example.com"))).text();
    expect(html).not.toContain('property="og:');
    expect(html).not.toContain('name="twitter:');
    expect(html).not.toContain("Should never be cached");
  });

  test("the same Share turns its card on when it is made public", async () => {
    const { slug, token } = await share("Flips public", false);
    const before = await (await fetch(`${base}/p/${slug}`, { headers: { "user-agent": "Twitterbot/1.0" } })).text();
    expect(before).not.toContain('property="og:title"');
    expect(await api(token)("POST", `/api/shares/${slug}/visibility`, { public: true })).toMatchObject({ status: 200 });
    const after = await (await fetch(`${base}/p/${slug}`, { headers: { "user-agent": "Twitterbot/1.0" } })).text();
    expect(meta(after, "property", "og:title")).toBe("Flips public");
  });
});

describe("the card image is fetchable without signing in", () => {
  test("GET returns real JPEG bytes with an immutable cache", async () => {
    const res = await fetch(`${base}/og.jpg`, { headers: { "user-agent": "Twitterbot/1.0" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toContain("immutable");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(1024);
    // A JPEG starts with SOI (FF D8) and ends with EOI (FF D9): the file is there, not an error page.
    expect([bytes[0], bytes[1], bytes.at(-2), bytes.at(-1)]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
  });

  test("HEAD answers the same headers without a body", async () => {
    const res = await fetch(`${base}/og.jpg`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  test("the path is public at the edge, or the crawler would get a login redirect", () => {
    const app = accessApp({ name: "an-instance", author: "me@example.com", allowlist: ["me@example.com"] }, "w123") as {
      destinations: { overrides: { path_pattern: string }[] }[];
    };
    const patterns = app.destinations[0]!.overrides.map((o) => o.path_pattern);
    expect(patterns).toContain("/og.jpg");
  });
});
