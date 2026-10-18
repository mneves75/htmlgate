// readConfig on its own: every setting fails closed, the ticket key and the expiry default included. No Worker.
import { describe, expect, test } from "vitest";
import { readConfig, type Env } from "../src/config";

const base = {
  ACCESS_TEAM_URL: "https://team.example.com", ACCESS_AUD: "aud", AUTHOR_EMAIL: "author@example.com",
  TICKET_KEY: "arx_oqk_HfZgIDMwWmF-0MNZrk_azyzkLwZL6MlJO3A",
} as unknown as Env;
const read = (over: Record<string, string | undefined>) => readConfig({ ...base, ...over } as Env);

describe("the ticket key", () => {
  test.each([undefined, "", "short", "a".repeat(44), "a".repeat(42) + "/"])("%j refuses everything", (key) => {
    expect(read({ TICKET_KEY: key })).toBeNull();
  });
  test("a 43-character key is kept", () => {
    expect(read({})!.ticketKey).toBe(base.TICKET_KEY);
  });
});

describe("the expiry default", () => {
  test("is 30 days when unset, and 0 means never", () => {
    expect(read({})!.expiryDays).toBe(30);
    expect(read({ EXPIRY_DAYS: "0" })!.expiryDays).toBe(0);
    expect(read({ EXPIRY_DAYS: "3650" })!.expiryDays).toBe(3650);
  });
  test.each(["-1", "1.5", "3651", "abc", "1e3", " 7x"])("%j refuses everything", (days) => {
    expect(read({ EXPIRY_DAYS: days })).toBeNull();
  });
});
