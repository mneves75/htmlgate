// `pnpm run token revoke-all`: one command for a lost laptop or a leaked token. It ends every token, then every open
// ticket (a new TICKET_KEY), then every Access sign-in to the Instance; each step is safe to repeat, so a failure is
// recovered by running the command again.
import { describe, expect, test } from "vitest";
// @ts-expect-error plain JavaScript module
import { revokeAll } from "../scripts/token.mjs";

const steps = (log: string[], fail?: string) => ({
  revokeTokens: () => { log.push("tokens"); if (fail === "tokens") throw new Error("d1 down"); return "3 revoked"; },
  rotateTicketKey: () => { log.push("ticket key"); if (fail === "ticket key") throw new Error("wrangler down"); return "replaced"; },
  revokeSessions: () => { log.push("sign-ins"); if (fail === "sign-ins") throw new Error("cf down"); return "revoked"; },
});

describe("revoke-all", () => {
  test("on a deployed Instance it ends tokens, then tickets, then Access sign-ins", () => {
    const log: string[] = [];
    const out: string[] = [];
    revokeAll(steps(log), { local: false, say: (l: string) => out.push(l) });
    expect(log).toEqual(["tokens", "ticket key", "sign-ins"]);
    expect(out).toEqual(["Tokens: 3 revoked.", "Ticket key: replaced.", "Access sign-ins: revoked."]);
  });

  test("a failed step stops the rest and says to run it again", () => {
    const log: string[] = [];
    expect(() => revokeAll(steps(log, "ticket key"), { local: false, say: () => {} })).toThrow(/Ticket key.*wrangler down.*revoke-all again/s);
    expect(log).toEqual(["tokens", "ticket key"]);
  });

  test("against a local database it revokes the tokens only, and says what it left", () => {
    const log: string[] = [];
    const out: string[] = [];
    revokeAll(steps(log), { local: true, say: (l: string) => out.push(l) });
    expect(log).toEqual(["tokens"]);
    expect(out.join("\n")).toContain("--local");
  });
});
