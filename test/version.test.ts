import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { homePage, notFoundPage, tokensPage, viewerPage } from "../src/pages";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const visitor = { email: "author@example.com", isAuthor: true, origin: "https://instance.example", lang: "en" } as const;

describe("the version an Instance page shows", () => {
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
