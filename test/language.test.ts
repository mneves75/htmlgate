// Each Instance speaks one language, chosen by its Operator: English unless instance.json says pt-BR.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { axeViolations } from "./a11y";
import { readConfig, type Env } from "../src/config";
import { AUD, AUTHOR, TICKET_KEY, VIEWER, settings, startInstance, type Instance } from "./global-setup";
import { accessJwt, api, asPerson, mintToken, page } from "./helpers";

describe("the LANGUAGE setting", () => {
  const env = (over: Record<string, string> = {}) =>
    ({ ACCESS_TEAM_URL: "https://team.example.com", ACCESS_AUD: AUD, AUTHOR_EMAIL: AUTHOR, TICKET_KEY, ...over }) as unknown as Env;

  test("is English when unset, and pt-BR when set so", () => {
    expect(readConfig(env())?.language).toBe("en");
    expect(readConfig(env({ LANGUAGE: "en" }))?.language).toBe("en");
    expect(readConfig(env({ LANGUAGE: "pt-BR" }))?.language).toBe("pt-BR");
  });

  test.each(["pt", "pt-br", "fr", "EN", " "])("refuses %j, like any other malformed setting", (value) => {
    expect(readConfig(env({ LANGUAGE: value }))).toBeNull();
  });
});

describe("a pt-BR Instance", () => {
  let inst: Instance;
  let call: ReturnType<typeof api>;
  const get = async (path: string, email?: string, init: RequestInit = {}) => {
    const r = await fetch(`${inst.base}${path}`, email ? await asPerson(email, { redirect: "manual", ...init }) : { redirect: "manual", ...init });
    return { status: r.status, headers: r.headers, body: await r.text() };
  };
  const form = (body: string) => ({
    method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", origin: inst.base, "sec-fetch-site": "same-origin" },
  });

  beforeAll(async () => {
    inst = await startInstance(settings(inject("teamUrl"), { LANGUAGE: "pt-BR" }));
    call = api(await mintToken("notebook", inst.base), inst.base);
  });
  afterAll(() => inst?.stop());

  test("before any Share, the home teaches publishing in pt-BR", async () => {
    const r = await get("/", AUTHOR);
    expect(r.body).toContain("Nenhum Share ainda");
    expect(r.body).toContain("0 Shares · 0 públicos");
    expect(r.body).toContain("Conecte a CLI <code>htmlgate</code> a esta Instância");
    expect(r.body).toContain(`htmlgate login ${inst.base}`);
  });

  test("every page declares pt-BR and speaks it", async () => {
    const d = (await call("POST", "/api/shares", { html: page("oi"), title: "Relatório" })).json;
    const pages: [string, Awaited<ReturnType<typeof get>>, string][] = [
      ["home of the Author", await get("/", AUTHOR), "Seus Shares"],
      ["home of a Viewer", await get("/", VIEWER), "Você entrou"],
      ["tokens", await get("/tokens", AUTHOR), "Criar token"],
      ["metrics", await get("/metrics", AUTHOR), "Métricas"],
      ["viewer", await get(`/s/${d.slug}`, VIEWER), "Abrir em nova aba"],
      ["viewer's expiry date", await get(`/s/${d.slug}`, VIEWER), "Expira em "],
      ["not found", await get("/p/ZZZZZZZZZZZZ"), "Não encontrado"],
    ];
    for (const [label, r, text] of pages) {
      expect(r.body, label).toContain('<html lang="pt-BR">');
      expect(r.body, label).toContain(text);
      expect(r.body, label).not.toContain("Skip to");
    }
  });

  test("counts, the older-Version notice, token states and the sign-in retry are in pt-BR", async () => {
    const d = (await call("POST", "/api/shares", { html: page("1"), title: "Versões" })).json;
    await call("PUT", `/api/shares/${d.slug}`, { html: page("2") });
    const old = await get(`/s/${d.slug}?v=1`, VIEWER);
    expect(old.body).toContain("Você está vendo a v1. A mais recente é a v2.");
    expect(old.body).toContain(`<a href="/s/${d.slug}">Ver a mais recente</a>`);
    expect((await get(`/p/${d.slug}`)).body).toContain("Entrar e tentar de novo");
    const home = await get("/", AUTHOR);
    expect(home.body).toMatch(/\d+ Shares · \d+ públicos?/);
    expect(home.body).toContain("Versão </span>");
    await get("/tokens", AUTHOR, form("name=revogar-me"));
    const id = (await call("GET", "/api/tokens")).json.data.find((x: { name: string }) => x.name === "revogar-me").id;
    const before = await get("/tokens", AUTHOR);
    expect(before.body).toContain('aria-label="Revogar revogar-me"');
    expect(before.body).toContain("Quem usa <strong>revogar-me</strong> para de funcionar no próximo pedido.");
    expect(before.body).toContain('<span class="on">Ativo</span>');
    await get(`/tokens/${id}/revoke`, AUTHOR, { method: "POST", headers: { origin: inst.base } });
    expect((await get("/tokens", AUTHOR)).body).toMatch(/Revogado <time/);
  });

  test("the Gated and Public states read Fechado and Público", async () => {
    const d = (await call("POST", "/api/shares", { html: page("x"), title: "Estado" })).json;
    expect((await get(`/s/${d.slug}`, VIEWER)).body).toContain('<span class="state state-gated">Fechado</span>');
    await call("POST", `/api/shares/${d.slug}/visibility`, { public: true });
    expect((await get(`/p/${d.slug}`)).body).toContain('<span class="state state-public">Público</span>');
  });

  test("the token form's answers are in pt-BR, with unchanged statuses", async () => {
    const ok = await get("/tokens", AUTHOR, form("name=celular"));
    expect(ok.status).toBe(200);
    expect(ok.body).toContain("Copie agora");
    expect(ok.body).toMatch(/<code id="new-token">hg_[A-Za-z0-9]{40}<\/code>/);
    const bad = await get("/tokens", AUTHOR, form(new URLSearchParams({ name: "a\nb" }).toString()));
    expect(bad.status).toBe(400);
    expect(bad.body).toContain("sem caracteres de controle");
    const big = await get("/tokens", AUTHOR, form("name=" + "a".repeat(8 * 1024)));
    expect(big.status).toBe(413);
    expect(big.body).toContain("grande demais");
    const refused = await get("/tokens", AUTHOR, { ...form("name=x"), headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" } });
    expect(refused.status).toBe(403);
    expect(refused.body).toContain("Recusado");
  });

  test("the pt-BR pages pass axe at phone width in light and dark, and never scroll sideways", async () => {
    const run = promisify(execFile);
    const BIN = join(process.cwd(), "node_modules/.bin/agent-browser");
    const SESSION = `htmlgate-lang-${process.pid}`;
    const ab = async (...args: string[]) => (await run(BIN, ["--session", SESSION, ...args], { timeout: 30_000 })).stdout.trim();
    const d = (await call("POST", "/api/shares", { html: page("x"), title: "Fechamento de outubro com um título bem comprido" })).json;
    await call("PUT", `/api/shares/${d.slug}`, { html: page("y") });
    try {
      for (const scheme of ["light", "dark"]) {
        await ab("open", "about:blank");
        await ab("set", "viewport", "390", "844");
        await ab("set", "media", scheme);
        await ab("set", "headers", JSON.stringify({ "cf-access-jwt-assertion": await accessJwt(AUTHOR) }));
        for (const path of ["/", "/tokens", `/s/${d.slug}?v=1`]) {
          await ab("open", `${inst.base}${path}`);
          await ab("wait", "--fn", "document.getAnimations().length === 0");
          expect(await axeViolations(ab), `${scheme} ${path}`).toEqual([]);
          expect(await ab("eval", "document.documentElement.scrollWidth <= window.innerWidth"), `${scheme} ${path}`).toBe("true");
        }
      }
    } finally {
      await ab("close").catch(() => {});
    }
  }, 180_000);

  test("not-found is the same page for a missing path and a refused Share", async () => {
    const d = (await call("POST", "/api/shares", { html: page("x"), title: "Fechado" })).json;
    const a = await get(`/s/${d.slug}`);
    const b = await get("/nada-aqui");
    expect(a.status).toBe(404);
    expect(a.body).toBe(b.body);
    expect(a.headers.get("content-security-policy")).toBe(b.headers.get("content-security-policy"));
  });
});
