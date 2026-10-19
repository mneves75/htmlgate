// Failing closed, the storage cap and the write rate limit. Decisions: #13, #14.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { inject } from "vitest";
import { AUTHOR, settings, startInstance, type Instance } from "./global-setup";
import { api, asPerson, mintToken, page } from "./helpers";

const teamUrl = inject("teamUrl");
const extra: Instance[] = [];
afterAll(() => Promise.all(extra.map((i) => i.stop())));

describe("an Instance missing its settings fails closed", () => {
  let bare: Instance;
  beforeAll(async () => {
    bare = await startInstance({});
    extra.push(bare);
  });

  test.each(["/", "/s/AAAAAAAAAAAA", "/s/AAAAAAAAAAAA/raw", "/p/AAAAAAAAAAAA", "/tokens", "/api/shares"])("%s answers 503 server_misconfigured", async (p) => {
    const r = await fetch(bare.base + p, await asPerson(AUTHOR));
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).error.code).toBe("server_misconfigured");
  });

  test("a ticket path on a misconfigured Instance still answers with no-referrer", async () => {
    const r = await fetch(bare.base + "/f/" + "A".repeat(64) + "/");
    expect(r.status).toBe(503);
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("an Access team URL over plain http fails closed, except on a local test host", async () => {
    const plain = await startInstance(settings(teamUrl, { ACCESS_TEAM_URL: "http://team.example.com" }));
    extra.push(plain);
    expect((await fetch(plain.base + "/", await asPerson(AUTHOR))).status).toBe(503);
  });

  test("a malformed Allowlist is missing settings too, not an empty one", async () => {
    const odd = await startInstance(settings(teamUrl, { ALLOWLIST: "not-an-email" }));
    extra.push(odd);
    expect((await fetch(odd.base + "/", await asPerson(AUTHOR))).status).toBe(503);
  });
});

describe("the storage cap", () => {
  test("a publish that would pass the Instance's cap is refused with quota_exceeded", async () => {
    const small = await startInstance(settings(teamUrl, { STORAGE_LIMIT_BYTES: String(2_500_000) }));
    extra.push(small);
    const base = small.base;
    const res = await fetch(`${base}/tokens`, await asPerson(AUTHOR, {
      method: "POST", headers: { origin: base, "content-type": "application/x-www-form-urlencoded" }, body: "name=quota",
    }));
    const token = /<code id="new-token">(hg_[A-Za-z0-9]+)<\/code>/.exec(await res.text())![1]!;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const big = page("x".repeat(1_000_000));
    const post = () => fetch(`${base}/api/shares`, { method: "POST", headers, body: JSON.stringify({ html: big, title: "big" }) });
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(201);
    const third = await post();
    expect(third.status).toBe(507);
    expect(((await third.json()) as any).error.code).toBe("quota_exceeded");
  });

  test("concurrent publishes cannot pass the cap together: the room is checked inside the write", async () => {
    const small = await startInstance(settings(teamUrl, { STORAGE_LIMIT_BYTES: String(2_500_000) }));
    extra.push(small);
    const base = small.base;
    const res = await fetch(`${base}/tokens`, await asPerson(AUTHOR, {
      method: "POST", headers: { origin: base, "content-type": "application/x-www-form-urlencoded" }, body: "name=race",
    }));
    const token = /<code id="new-token">(hg_[A-Za-z0-9]+)<\/code>/.exec(await res.text())![1]!;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const big = page("y".repeat(1_000_000));
    const first = await fetch(`${base}/api/shares`, { method: "POST", headers, body: JSON.stringify({ html: big, title: "first" }) });
    const { slug } = (await first.json()) as { slug: string };
    // One slot of room is left; six creates and six new Versions race for it.
    const racing = await Promise.all([
      ...Array.from({ length: 6 }, () => fetch(`${base}/api/shares`, { method: "POST", headers, body: JSON.stringify({ html: big, title: "race" }) })),
      ...Array.from({ length: 6 }, () => fetch(`${base}/api/shares/${slug}`, { method: "PUT", headers, body: JSON.stringify({ html: big }) })),
    ]);
    const codes = racing.map((r) => r.status);
    expect(codes.filter((c) => c === 200 || c === 201).length, codes.join(",")).toBeLessThanOrEqual(1);
    expect(codes.every((c) => [200, 201, 507].includes(c)), codes.join(",")).toBe(true);
    // Every refused create left no Share behind, and every refused Version left the Share on a Version it has.
    const list = (await (await fetch(`${base}/api/shares`, { headers })).json()) as { data: { slug: string }[] };
    expect(list.data.length).toBe(1 + codes.filter((c) => c === 201).length);
    const versions = (await (await fetch(`${base}/api/shares/${slug}/versions`, { headers })).json()) as { data: { n: number }[] };
    const latest = ((await (await fetch(`${base}/api/shares/${slug}`, { headers })).json()) as { latest_version: number }).latest_version;
    expect(versions.data.map((v) => v.n)).toContain(latest);
  });
});

describe("request bodies", () => {
  test("a body that never ends is refused once it passes the cap, without waiting for its end", async () => {
    const token = await mintToken("endless");
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    // One attempt: an endless body as far as the Worker can tell, stopping once the answer is in (or at 200 MiB) so it
    // never keeps this process busy after the test. A refused socket surfaces as a TypeError rather than an answer, so
    // the attempt reports that instead of throwing: it is the local dev proxy's cut, not a test verdict.
    const attempt = async () => {
      let sent = 0;
      let answered = false;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (answered || sent >= 200 * 1024 * 1024) return c.close();
          sent += chunk.length;
          c.enqueue(chunk);
        },
      });
      const started = Date.now();
      try {
        const r = await fetch(`${inject("base")}/api/shares`, {
          // connection: close keeps the cut socket out of fetch's pool, where a later request would hit EPIPE.
          method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" }, body, duplex: "half",
        } as RequestInit);
        return { r, sent, elapsed: Date.now() - started };
      } catch (e) {
        if (e instanceof TypeError) return { terminated: e.message, sent, elapsed: Date.now() - started };
        throw e;
      } finally {
        answered = true;
      }
    };
    let outcome = await attempt();
    // The Worker answers 413 without reading on. Wrangler's local dev proxy (not present in production) sometimes
    // reports that early answer as a 500 "Network connection lost", or terminates the request outright. Nothing else
    // is accepted, and a termination twice is a failed assertion, not a broken test.
    if ("terminated" in outcome) outcome = await attempt();
    expect("terminated" in outcome ? outcome.terminated : undefined, "the request terminated without an answer twice").toBeUndefined();
    const { r, sent, elapsed } = outcome as { r: Response; sent: number; elapsed: number };
    const answer = await r.text();
    if (r.status === 500) expect(answer).toMatch(/^Error: Network connection lost\./);
    else {
      expect(r.status).toBe(413);
      expect(JSON.parse(answer).error.code).toBe("html_too_large");
    }
    expect(elapsed).toBeLessThan(15_000);
    expect(sent).toBeLessThan(200 * 1024 * 1024);
  });
});

describe("the write rate limit", () => {
  test("a token gets 429 with Retry-After after 60 changes in a minute, and reads still work", async () => {
    const call = api(await mintToken("busy"));
    const { json: d } = await call("POST", "/api/shares", { html: page("0"), title: "busy" });
    // The limiter counts a rolling minute, so the burst has to finish inside it. Sent one at a time, 70 writes can each
    // take most of a second on a loaded host (a full suite runs several Instances at once), the earliest age out of the
    // window, and a working limiter reads as no limit at all. Four at a time keeps the burst inside the window without
    // changing what is asserted: the same token, the same 60-change limit, and the first 429 must carry Retry-After.
    let limited: Awaited<ReturnType<typeof call>> | undefined;
    for (let i = 1; i <= 70 && !limited; i += 4) {
      const answers = await Promise.all(Array.from({ length: Math.min(4, 71 - i) }, (_, k) =>
        call("PATCH", `/api/shares/${d.slug}`, { title: "busy " + (i + k) })));
      for (const r of answers) {
        if (r.status === 429) { limited = r; break; }
        expect(r.status).toBe(200);
      }
    }
    expect(limited, "no 429 within 70 writes").toBeDefined();
    expect(limited!.json.error.code).toBe("rate_limited");
    expect(limited!.headers.get("retry-after")).toBe("60");
    expect((await call("GET", `/api/shares/${d.slug}`)).status).toBe(200);
  });
});
