// Tickets (src/ticket.ts) on their own: a sealed permission to read one Version of one Share's files.
// Runs in Node; no Worker needed.
import { expect, test } from "vitest";
import { importTicketKey, openTicket, sealTicket, TICKET_TTL_MS, type Ticket } from "../src/ticket";

const KEY = "k".repeat(43);
const AUD = "instance-aud";
const OTHER = "o".repeat(43);
const t: Ticket = { slug: "abcdefABCDEF", n: 3, email: "viewer@example.com", exp: Date.now() + TICKET_TTL_MS };

test("a sealed ticket opens to what was sealed, and only with its key", async () => {
  const key = (await importTicketKey(KEY))!;
  const sealed = await sealTicket(key, AUD, t);
  expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(await openTicket(key, AUD, sealed)).toEqual(t);
  expect(await openTicket((await importTicketKey(OTHER))!, AUD, sealed)).toBeNull();
  expect(await openTicket(key, "another-instance", sealed)).toBeNull();
});

test("a ticket hides who it was issued to, and no two are alike", async () => {
  const key = (await importTicketKey(KEY))!;
  const a = await sealTicket(key, AUD, t);
  const b = await sealTicket(key, AUD, t);
  expect(a).not.toBe(b);
  const text = Buffer.from(a, "base64url").toString("latin1");
  expect(text).not.toContain("viewer");
  expect(text).not.toContain("abcdefABCDEF");
});

test("any change to a ticket makes it worthless", async () => {
  const key = (await importTicketKey(KEY))!;
  const sealed = await sealTicket(key, AUD, t);
  for (const i of [0, 5, 20, sealed.length - 1]) {
    const flipped = sealed.slice(0, i) + (sealed[i] === "A" ? "B" : "A") + sealed.slice(i + 1);
    expect(await openTicket(key, AUD, flipped)).toBeNull();
  }
  for (const bad of ["", "short", sealed + "=", sealed.replace(/./, "/"), "A".repeat(2000)]) {
    expect(await openTicket(key, AUD, bad)).toBeNull();
  }
});

test("only a 43-character base64url key (32 bytes) is accepted", async () => {
  for (const bad of ["", "k".repeat(42), "k".repeat(44), "k".repeat(42) + "/", "k".repeat(42) + "="]) {
    expect(await importTicketKey(bad)).toBeNull();
  }
});
