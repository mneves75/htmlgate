// The edge harness pins each arm of an A/B to its own Worker Version on every request, warm ones included, and
// refuses a comparison whose two arms would run the same Version (reviewer finding 4, docs/perf/REVIEW.md).
import { describe, expect, test } from "vitest";
// @ts-expect-error: a plain .mjs script without types
import { args, armOptions, parseBase } from "../scripts/perf/edge.mjs";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("edge harness Version pins", () => {
  test("a pinned arm sends the override header; an unpinned one sends none", () => {
    const pinned = armOptions(parseBase(`https://app.example.com/|htmlgate-app=${A}`));
    expect(pinned).toContain(`cloudflare-workers-version-overrides: htmlgate-app="${A}"`);
    expect(armOptions(parseBase("https://app.example.com")).join(" ")).not.toContain("overrides");
  });

  test("two arms on two Versions run; the same Version twice, or one arm pinned alone, is refused", () => {
    expect(args(["--base", `https://x.example|w=${A}`, "--base", `https://x.example|w=${B}`, "--paths", "/"]).bases).toHaveLength(2);
    expect(() => args(["--base", `https://x.example|w=${A}`, "--base", `https://x.example|w=${A}`, "--paths", "/"])).toThrow(/same Version/);
    expect(() => args(["--base", `https://x.example|w=${A}`, "--base", "https://x.example", "--paths", "/"])).toThrow(/every arm/);
    expect(() => parseBase("https://x.example|w=latest")).toThrow(/version-id/);
  });
});
