// The release is written where a person reads it: the Instance's footer and every landing page. `package.json` is
// the one number they all have to agree with, so a release that forgets a page fails here instead of drifting.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { homePage, notFoundPage, tokensPage, viewerPage } from "../src/pages";
import { VERSION } from "../src/version";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const LANDING = [
  "site/public/index.html",
  "site/public/en/index.html",
  "site/public/privacidade/index.html",
  "site/public/en/privacy/index.html",
  "site/public/404.html",
];
const visitor = { email: "author@example.com", isAuthor: true, origin: "https://instance.example", lang: "en" } as const;

describe("the version a page shows", () => {
  test("src/version.ts carries the package version", () => expect(VERSION).toBe(version));

  test.each(LANDING)("%s shows it once, in its footer", (file) => {
    const html = readFileSync(file, "utf8");
    expect(html.match(/<span class="version">/g) ?? []).toHaveLength(1);
    expect(html).toContain(`<span class="version">${version}</span>`);
  });

  test.each(["en", "pt-BR"] as const)("the not-found page shows it (%s)", async (lang) => {
    const { body } = await notFoundPage(lang, { home: "author" });
    expect(body).toContain(`<p class="ver">htmlgate ${version}</p>`);
    expect(body.match(/htmlgate \d+\.\d+\.\d+/g) ?? []).toHaveLength(1);
  });

  test("the home and token pages carry it in their footer", async () => {
    const home = await homePage(visitor, { total: 0, publicTotal: 0, shares: [] });
    expect(home.body).toContain(`<footer class="foot">htmlgate ${version}</footer>`);
    const tokens = await tokensPage(visitor, []);
    expect(tokens.body).toContain(`<footer class="foot">htmlgate ${version}</footer>`);
  });

  test("a viewer page carries it in the bar, not over the Share", async () => {
    const share = { slug: "AAAAAAAAAAAA", title: "Report", public: 1, updated_at: 0, expires_at: null };
    const { body } = await viewerPage("en", share, "p", 1, [1], 1);
    expect(body).toContain(`<span class="ver">v${version}</span>`);
    expect(body).not.toContain('<footer class="foot">');
  });
});
