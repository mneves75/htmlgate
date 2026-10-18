// The red-team pass's permanent regression tests: the erased note never lies (a link cannot make the home say a live
// Share was erased), no off-origin redirect exists, undocumented verbs answer exactly nothing, every broken ticket
// seal is byte-identical not-found, and the visibility switch takes nothing but public.
// One-time full battery: .scratch/attacks/{identity,limits,external}/report.md.
import { beforeAll, describe, expect, test } from "vitest";
import { importTicketKey, sealTicket } from "../src/ticket";
import { AUD, AUTHOR, TICKET_KEY } from "./global-setup";
import { asPerson, base, page } from "./helpers";
import { full, get, newCaller } from "./reviewer-helpers";

let token: string;
let call: Awaited<ReturnType<typeof newCaller>>["call"];
let slug: string;

beforeAll(async () => {
  ({ token, call } = await newCaller("redteam"));
  slug = (await call("POST", "/api/shares", { html: page("redteam marker"), title: "Redteam" })).json.slug as string;
});

/** The erased note as it names one slug (src/pages.ts, en and pt-BR). The home always carries the "Erase a Share
 * for good" panel, so a probe must look for the slug-tied note and not the bare phrase. */
const erasedNote = (s: string) => new RegExp(`Erased <code>${s}</code> for good|<code>${s}</code> eliminado de vez`);

/** A form POST from the Instance's own page, the way a person sends one (same-origin Origin header). */
async function formPost(path: string, fields: Record<string, string>) {
  return fetch(base + path, {
    ...(await asPerson(AUTHOR, { method: "POST", headers: { origin: base, "content-type": "application/x-www-form-urlencoded" } })),
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

describe("the erased note never lies", () => {
  test("a live Share's home never shows the erased note, even named in the link (IMP-C3)", async () => {
    // The forgery probe: naming a live Share in ?erased must not produce the note.
    const live = await get(`/?erased=${slug}`, await asPerson(AUTHOR));
    expect(live.status).toBe(200);
    expect(live.body).not.toMatch(erasedNote(slug));

    // The control, and the mirror direction: after the real erase, the same link does show the note.
    const erased = await formPost("/erase", { share: slug, confirm: "1" });
    expect(erased.status).toBe(303);
    expect(erased.headers.get("location")).toBe(`/?erased=${slug}`);
    const shown = await get(`/?erased=${slug}`, await asPerson(AUTHOR));
    expect(shown.status).toBe(200);
    expect(shown.body).toMatch(erasedNote(slug));

    // Off-shape values never become a note, never a redirect, and are never reflected (LIM-C8.1, C8.2).
    for (const [raw, reflected] of [["//evil.com", "evil.com"], ["%3Cimg%3E", "<img"]] as const) {
      const r = await get(`/?erased=${raw}`, await asPerson(AUTHOR));
      expect(r.status, raw).toBe(200);
      expect(r.headers.get("location"), raw).toBeNull();
      expect(r.body, raw).not.toMatch(erasedNote(slug));
      expect(r.body, raw).not.toContain(reflected);
    }
  });
});

describe("no off-origin Location anywhere", () => {
  test("the Instance's redirects are only the documented same-origin ones (LIM-C8)", async () => {
    // LIM-C8.1–C8.6, C8.10: none of these parameters exists, so each is a plain page with no Location at all.
    for (const p of ["/?next=//evil.com", "/?redirect=//evil.com", "/tokens?next=//evil.com", "/?erased=https://evil.com", "/?erased=@evil.com"]) {
      const r = await get(p, await asPerson(AUTHOR));
      expect(r.status, p).toBe(200);
      expect(r.headers.get("location"), p).toBeNull();
    }
    // LIM-C8.7: the one documented redirect is the Author's own erase, and it is same-origin relative.
    const second = (await call("POST", "/api/shares", { html: page("redteam second"), title: "Redteam second" })).json.slug as string;
    const erased = await formPost("/erase", { share: second, confirm: "1" });
    expect(erased.status).toBe(303);
    expect(erased.headers.get("location")).toBe(`/?erased=${second}`);
  });
});

describe("undocumented verbs answer nothing", () => {
  test("method confusion on people paths and the API (LIM-A3/A4)", async () => {
    const own = (await call("POST", "/api/shares", { html: page("redteam verbs"), title: "Redteam verbs" })).json.slug as string;
    for (const p of ["/", "/tokens", "/erase", `/s/${own}`, `/p/${own}/raw`]) {
      for (const verb of ["PUT", "POST", "PATCH", "DELETE", "OPTIONS"]) {
        const r = await get(p, { ...(await asPerson(AUTHOR, { headers: { origin: base } })), method: verb, redirect: "manual" });
        // The two documented POST flows, with an empty body that names neither a Share nor a token.
        if (verb === "POST" && (p === "/erase" || p === "/tokens")) {
          expect(r.status, `${verb} ${p}`).toBe(400);
          continue;
        }
        // LIM-A3.1: every other verb/path answers the same 404 not-found, never 2xx and never 5xx.
        expect(r.status, `${verb} ${p}`).toBe(404);
      }
    }
    // The empty-body erase changed nothing.
    expect((await call("GET", `/api/shares/${own}`)).status).toBe(200);
    // LIM-A4.1: PUT /api/shares with no slug.
    const put = await call("PUT", "/api/shares");
    expect(put.status).toBe(404);
    expect(put.json.error.code).toBe("not_found");
    // LIM-A4.2: a form-encoded body on the visibility endpoint is refused as invalid JSON.
    const formBody = await fetch(`${base}/api/shares/${own}/visibility`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
      body: "public=1",
      redirect: "manual",
    });
    expect(formBody.status).toBe(400);
    expect(((await formBody.json()) as any).error.code).toBe("invalid_json");
  });
});

describe("a tampered ticket is exactly not-found", () => {
  test("every broken seal answers one identical 404 (IMP-B8)", async () => {
    const key = (await importTicketKey(TICKET_KEY))!;
    const sealed = await sealTicket(key, AUD, { slug: "AAAAAAAAAAAA", n: 1, email: AUTHOR, exp: Date.now() + 3_600_000 });
    const baseline = full(await get(`/f/${sealed}/`));
    expect(baseline.status).toBe(404);
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
    const tampered = [
      flip(sealed, 0), flip(sealed, 5), flip(sealed, 50),
      sealed.slice(0, -6),
      `${sealed}A`,
      `x${sealed}`,
      sealed.slice(0, 20) + sealed.slice(30),
      sealed.slice(0, 40) + sealed.slice(50),
    ];
    // AES-GCM's auth tag rejects every change before any check can be probed: one status and body-hash for all.
    for (const t of tampered) {
      const r = await get(`/f/${t}/`);
      expect(r.status, t).toBe(404);
      expect(full(r), t).toEqual(baseline);
    }
  });
});

describe("the visibility switch takes nothing but public", () => {
  test("extra fields on /visibility are refused (IMP-B5)", async () => {
    const own = (await call("POST", "/api/shares", { html: page("redteam visibility"), title: "Redteam visibility" })).json.slug as string;
    for (const body of [{ public: true, role: "admin" }, { public: "yes" }, { public: 1 }]) {
      const r = await call("POST", `/api/shares/${own}/visibility`, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error.code, JSON.stringify(body)).toBe("invalid_arg");
      expect((await call("GET", `/api/shares/${own}`)).json.public, JSON.stringify(body)).toBe(false);
    }
    const ok = await call("POST", `/api/shares/${own}/visibility`, { public: false });
    expect(ok.status).toBe(200);
    expect(ok.json.public).toBe(false);
    expect((await call("GET", `/api/shares/${own}`)).json.public).toBe(false);
  });
});
