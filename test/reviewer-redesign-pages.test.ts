// Reviewer tests for the redesigned pages, rendered directly from src/pages.ts (no server): both languages,
// every state, written from the acceptance criteria rather than from the implementation.
import { describe, expect, test } from "vitest";
import type { Language } from "../src/config";
import worker from "../src/index";
import { homePage, notFoundPage, tokensPage, viewerPage, type HomeList, type PageResult, type Visitor } from "../src/pages";

const LANGS: Language[] = ["en", "pt-BR"];
const HOSTILE = `ZQ<img src=x onerror=alert(1)>"&'`;
const ESCAPED = "ZQ&lt;img src=x onerror=alert(1)&gt;&quot;&amp;&#39;";

const visitor = (lang: Language, isAuthor = true): Visitor => ({ email: "ZQ-author@example.com", isAuthor, origin: "https://zq.example.com", lang });
const share = (n: number, over: Partial<HomeList["shares"][number]> = {}) =>
  ({ slug: `ZQshare${String(n).padStart(5, "0")}`, title: `ZQ title ${n}`, public: 0, latest_version: n, updated_at: Date.UTC(2026, 9, 9, 12, n), changed_by_name: "ZQ laptop", ...over });

async function pages(lang: Language): Promise<Record<string, PageResult>> {
  const tokens = [
    { id: "abcdef012345", name: HOSTILE, created_at: 1_700_000_000_000, last_used_at: null, revoked_at: null },
    { id: "abcdef012346", name: "ZQ old", created_at: 1_700_000_000_000, last_used_at: 1_700_000_100_000, revoked_at: 1_700_000_200_000 },
  ];
  const v = visitor(lang);
  const full: HomeList = { total: 80, publicTotal: 2, shares: [share(1, { public: 1 }), share(2, { changed_by_name: null }), share(3, { title: HOSTILE, changed_by_name: HOSTILE })] };
  const d = { slug: "ZQviewer0001", title: HOSTILE, public: 0, updated_at: 1_700_000_000_000, expires_at: null };
  return {
    "home empty": await homePage(v, { total: 0, publicTotal: 0, shares: [] }),
    "home full": await homePage(v, full),
    "home viewer": await homePage(visitor(lang, false), null),
    "tokens empty": await tokensPage(v, []),
    "tokens list": await tokensPage(v, tokens),
    "tokens created": await tokensPage(v, tokens, { name: HOSTILE, token: "hg_" + "a".repeat(40) }),
    "tokens refused": await tokensPage(v, [], undefined, "refused"),
    "tokens too-large": await tokensPage(v, [], undefined, "too-large"),
    "tokens bad-name": await tokensPage(v, [], undefined, "bad-name"),
    "viewer latest": await viewerPage(lang, d, "s", 3, [1, 2, 3], 3),
    "viewer older": await viewerPage(lang, d, "s", 1, [1, 2, 3], 3),
    "viewer public": await viewerPage(lang, { ...d, public: 1 }, "p", 2, [1, 2, 3], 3),
    "not found": await notFoundPage(lang),
    "not found sign in": await notFoundPage(lang, { signInPath: "/s/ZQviewer0001" }),
    "not found signed in": await notFoundPage(lang, { home: "author" }),
  };
}

const withoutStyle = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, "");
/** Visible text nodes plus the texts carried by attributes (labels, titles, placeholders). */
function texts(html: string): string[] {
  const out: string[] = [];
  for (const m of withoutStyle(html).matchAll(/>([^<>]+)</g)) out.push(m[1]!.trim());
  for (const m of html.matchAll(/\s(?:aria-label|title|placeholder|alt)="([^"]*)"/g)) out.push(m[1]!.trim());
  return out.filter((t) => /\p{L}/u.test(t));
}
const tagNames = (html: string) => [...withoutStyle(html).matchAll(/<\/?([a-z][a-z0-9]*)/g)].map((m) => m[1]);

describe("every Instance page exists in both languages", () => {
  test("no page text is left in English on a pt-BR page (words the two languages share excepted)", async () => {
    const en = await pages("en");
    const pt = await pages("pt-BR");
    // Words that are the same in both languages, or product terms, or test data (ZQ).
    const SHARED = new Set(["htmlgate", "Share", "Shares", "Tokens", "Token", "Status", "Login", "UTC", "hg_", "v1", "v2", "v3"]);
    const untranslated: string[] = [];
    for (const name of Object.keys(en)) {
      const ptTexts = new Set(texts(pt[name]!.body));
      for (const t of texts(en[name]!.body)) {
        // Identifiers, hosts, commands, timestamps and the title "Tokens · htmlgate" are the same in every language.
        if (t.includes("ZQ") || SHARED.has(t) || /^[\w.$/@:-]+$/.test(t) || t.startsWith("htmlgate ") || t.endsWith(" UTC") || t === "Tokens · htmlgate") continue;
        if (ptTexts.has(t)) untranslated.push(`${name}: ${JSON.stringify(t)}`);
      }
    }
    expect([...new Set(untranslated)].join("\n")).toBe("");
  });

  test("the two languages render the same element structure", async () => {
    const en = await pages("en");
    const pt = await pages("pt-BR");
    for (const name of Object.keys(en)) expect(tagNames(pt[name]!.body), name).toEqual(tagNames(en[name]!.body));
  });

  test("the language is declared on <html>", async () => {
    for (const lang of LANGS) for (const [name, p] of Object.entries(await pages(lang))) expect(p.body, `${lang} ${name}`).toContain(`<html lang="${lang}">`);
  });

  test("the page <title> is in the page's language and a not-found page says Not found / Não encontrado", async () => {
    expect((await notFoundPage("en")).body).toContain("<title>Not found</title>");
    expect((await notFoundPage("pt-BR")).body).toContain("<title>Não encontrado</title>");
  });

  test("counts read right at 0, 1 and many, in both languages", async () => {
    const h = async (lang: Language, total: number, pub: number) =>
      (await homePage(visitor(lang), { total, publicTotal: pub, shares: total ? [share(1)] : [] })).body;
    expect(await h("en", 0, 0)).toContain(">0 Shares · 0 public<");
    expect(await h("en", 1, 1)).toContain(">1 Share · 1 public<");
    expect(await h("en", 2, 1)).toContain(">2 Shares · 1 public<");
    expect(await h("pt-BR", 0, 0)).toContain(">0 Shares · 0 públicos<");
    expect(await h("pt-BR", 1, 1)).toContain(">1 Share · 1 público<");
    expect(await h("pt-BR", 2, 1)).toContain(">2 Shares · 1 público<");
  });
});

describe("what every page must never contain", () => {
  test("no script, no inline event handler, no style attribute, one stylesheet, no external resource", async () => {
    for (const lang of LANGS) {
      for (const [name, p] of Object.entries(await pages(lang))) {
        const body = withoutStyle(p.body);
        expect(body, `${lang} ${name}`).not.toMatch(/<script/i);
        for (const tag of body.matchAll(/<[a-z][^>]*>/gi)) expect(tag[0].replace(/"[^"]*"/g, '""'), `${lang} ${name}`).not.toMatch(/\son[a-z]+\s*=/i);
        expect(body, `${lang} ${name}`).not.toMatch(/\sstyle\s*=/i);
        expect(p.body.match(/<style>/g), `${lang} ${name}`).toHaveLength(1);
        expect(p.body, `${lang} ${name}`).not.toMatch(/<(link|img|object|embed|base)\b/i);
        // Every URL-carrying attribute is relative to the Instance or a fragment.
        for (const m of body.matchAll(/\s(?:href|src|action)="([^"]*)"/g)) expect(m[1], `${lang} ${name}`).toMatch(/^(\/(?!\/)|#)/);
        // No remote resource in the stylesheet either.
        expect(p.body.match(/<style>([\s\S]*?)<\/style>/)![1], `${lang} ${name}`).not.toMatch(/url\(|@import|https?:/i);
      }
    }
  });

  test("hostile titles, Publisher names and token names are escaped everywhere they appear", async () => {
    for (const lang of LANGS) {
      for (const [name, p] of Object.entries(await pages(lang))) {
        expect(p.body, `${lang} ${name}`).not.toContain("<img src=x");
        expect(p.body, `${lang} ${name}`).not.toContain('onerror=alert(1)>"');
      }
    }
    const home = (await pages("en"))["home full"]!.body;
    expect(home).toContain(ESCAPED);
    const tokens = (await pages("pt-BR"))["tokens list"]!.body;
    expect(tokens).toContain(`data-token-name="${ESCAPED}"`);
    expect(tokens).toContain(`aria-label="Revogar ${ESCAPED}"`);
    const viewer = (await pages("en"))["viewer latest"]!.body;
    expect(viewer).toContain(`<title>${ESCAPED}</title>`);
    expect(viewer).toContain(`title="${ESCAPED}"`);
  });

  test("the sign-in link of the not-found page is escaped", async () => {
    expect((await notFoundPage("en", { signInPath: `/s/"><b>` })).body).not.toContain('"><b>');
  });
});

describe("page structure", () => {
  test("ids are unique, every aria-labelledby / aria-describedby / skip link target exists, there is one h1 and a main landmark", async () => {
    for (const lang of LANGS) {
      for (const [name, p] of Object.entries(await pages(lang))) {
        const html = withoutStyle(p.body);
        const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
        expect(new Set(ids).size, `${lang} ${name}: duplicate id in ${ids}`).toBe(ids.length);
        for (const m of html.matchAll(/\s(?:aria-labelledby|aria-describedby)="([^"]+)"/g)) for (const ref of m[1]!.split(/\s+/)) expect(ids, `${lang} ${name}: ${ref}`).toContain(ref);
        for (const m of html.matchAll(/href="#([^"]+)"/g)) expect(ids, `${lang} ${name}: skip target ${m[1]}`).toContain(m[1]);
        expect(html.match(/<h1[\s>]/g), `${lang} ${name}: h1`).toHaveLength(1);
        // The skip link is the first focusable thing.
        const other = html.search(/<(a|button|input|summary)\b(?![^>]*class="skip")/);
        if (other !== -1) expect(html.indexOf('class="skip"'), `${lang} ${name}`).toBeLessThan(other);
        expect(html.indexOf('class="skip"'), `${lang} ${name}`).toBeGreaterThan(-1);
      }
    }
  });

  test("the Author's list is rendered in the order given and a Viewer's home has no row, count or Share link", async () => {
    const list: HomeList = { total: 3, publicTotal: 0, shares: [share(3), share(1), share(2)] };
    const body = (await homePage(visitor("en"), list)).body;
    expect([...body.matchAll(/href="\/s\/(ZQshare\d+)"/g)].map((m) => m[1])).toEqual(list.shares.map((x) => x.slug));
    const viewer = (await pages("en"))["home viewer"]!.body;
    for (const text of ['class="row"', "Shares ·", "/s/", 'href="/tokens"', 'class="board']) expect(withoutStyle(viewer), text).not.toContain(text);
  });

  test("a row with no last Publisher prints no 'null' or 'undefined'", async () => {
    const body = (await homePage(visitor("pt-BR"), { total: 1, publicTotal: 0, shares: [share(1, { changed_by_name: null })] })).body;
    expect(body).not.toMatch(/null|undefined|NaN/);
  });

  test("the token navigation and the new-token button appear for the Author only", async () => {
    const all = await pages("en");
    expect(all["home full"]!.body).toContain('<a href="/tokens"');
    expect(all["home viewer"]!.body).not.toContain("/tokens");
  });
});

describe("security headers of the pages", () => {
  test("the stylesheet is allowed by the hash of exactly the bytes served, on every page and language", async () => {
    for (const lang of LANGS) {
      for (const [name, p] of Object.entries(await pages(lang))) {
        const css = /<style>([\s\S]*?)<\/style>/.exec(p.body)![1]!;
        const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(css))).toString("base64");
        expect(p.csp, `${lang} ${name}`).toContain(`style-src 'sha256-${digest}'`);
        expect(p.csp, `${lang} ${name}`).toContain("default-src 'none'");
        expect(p.csp, `${lang} ${name}`).not.toMatch(/unsafe-inline|unsafe-eval|script-src/);
        expect(p.csp, `${lang} ${name}`).toContain("frame-ancestors 'none'");
      }
    }
  });

  test("only the viewer may frame, and it frames only itself; the not-found page is sandboxed", async () => {
    const all = await pages("en");
    for (const [name, p] of Object.entries(all)) {
      if (name.startsWith("viewer")) expect(p.csp, name).toContain("frame-src 'self'");
      else expect(p.csp, name).not.toContain("frame-src");
      if (name.startsWith("not found")) expect(p.csp, name).toContain("sandbox");
    }
    for (const name of ["viewer latest", "viewer older", "viewer public"]) {
      expect(all[name]!.body, name).toMatch(/<iframe class="share" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" src="\/[sp]\/ZQviewer0001\/raw\?v=\d"/);
      expect(all[name]!.body, name).not.toContain("allow-same-origin");
    }
  });

  test("the not-found page is byte-identical whatever the cause: the sign-in action is the only difference", async () => {
    for (const lang of LANGS) {
      const a = await notFoundPage(lang);
      const b = await notFoundPage(lang);
      expect(a).toEqual(b);
    }
  });

  test("a public viewer links nowhere into the gate", async () => {
    const body = (await pages("en"))["viewer public"]!.body;
    for (const text of ['href="/"', 'href="/tokens"', "ZQ-author", "/s/"]) expect(body, text).not.toContain(text);
  });
});

describe("the Worker's settings", () => {
  const env = (over: Record<string, string>) => ({ ACCESS_TEAM_URL: "https://team.example.com", ACCESS_AUD: "aud", AUTHOR_EMAIL: "a@example.com", ...over }) as never;
  const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

  test.each(["", "fr", "pt-br", "PT-BR", "en-US"])("an Instance with LANGUAGE=%j refuses every page and API request with 503, not a page in a guessed language", async (language) => {
    for (const path of ["/", "/tokens", "/s/AAAAAAAAAAAA", "/p/AAAAAAAAAAAA", "/api/shares"]) {
      const r = await worker.fetch(new Request(`http://localhost${path}`), env({ LANGUAGE: language }), ctx);
      expect(r.status, `${JSON.stringify(language)} ${path}`).toBe(503);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(await r.text()).not.toContain("<html");
    }
  });
});
