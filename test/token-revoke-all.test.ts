// `pnpm run token revoke-all`: one command for a lost laptop or a leaked token. It first checks that Wrangler and cf act
// on the same account and match the Instance's Worker and Access application, then ends every Access
// sign-in, so a stolen session cannot make a token while the rest runs, then every token, then every open ticket (a
// new TICKET_KEY). Each step is safe to repeat, so a failure is recovered by running the command again.
import { describe, expect, test } from "vitest";
// @ts-expect-error plain JavaScript module
import { revokeAll } from "../scripts/token.mjs";

const steps = (log: string[], fail?: string) => ({
  checkAccount: () => { log.push("account"); if (fail === "account") throw new Error("Wrangler and cf use different accounts"); return "Wrangler and cf use the same one"; },
  revokeSessions: () => { log.push("sign-ins"); if (fail === "sign-ins") throw new Error("cf down"); return "revoked"; },
  revokeTokens: () => { log.push("tokens"); if (fail === "tokens") throw new Error("d1 down"); return "3 revoked"; },
  rotateTicketKey: () => { log.push("ticket key"); if (fail === "ticket key") throw new Error("wrangler down"); return "replaced"; },
});

describe("revoke-all", () => {
  test("on a deployed Instance it checks the account, then ends Access sign-ins, tokens and tickets, in that order", () => {
    const log: string[] = [];
    const out: string[] = [];
    revokeAll(steps(log), { local: false, say: (l: string) => out.push(l) });
    expect(log).toEqual(["account", "sign-ins", "tokens", "ticket key"]);
    expect(out).toEqual(["Account: Wrangler and cf use the same one.", "Access sign-ins: revoked.", "Tokens: 3 revoked.", "Ticket key: replaced."]);
  });

  test("on two accounts it touches nothing", () => {
    const log: string[] = [];
    expect(() => revokeAll(steps(log, "account"), { local: false, say: () => {} })).toThrow(/Account.*different accounts/s);
    expect(log).toEqual(["account"]);
  });

  test("a failed step stops the rest and says to run it again", () => {
    const log: string[] = [];
    expect(() => revokeAll(steps(log, "tokens"), { local: false, say: () => {} })).toThrow(/Tokens.*d1 down.*revoke-all again/s);
    expect(log).toEqual(["account", "sign-ins", "tokens"]);
  });

  test("against a local database it revokes the tokens only, and says what it left", () => {
    const log: string[] = [];
    const out: string[] = [];
    revokeAll(steps(log), { local: true, say: (l: string) => out.push(l) });
    expect(log).toEqual(["tokens"]);
    expect(out.join("\n")).toContain("--local");
  });
});
