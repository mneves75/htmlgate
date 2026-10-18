// The project config's api_url line, read from a file a cloned repository chooses: parsed in linear time.
import { expect, test } from "vitest";
import { parseApiUrl } from "../packages/cli/src/config";

test("api_url is read from its line, with a trailing comment or single quotes, and nothing else", () => {
  expect(parseApiUrl('api_url = "https://a.example"\n')).toBe("https://a.example");
  expect(parseApiUrl("# x\n\n  api_url='https://b.example' # staging\r\n")).toBe("https://b.example");
  expect(parseApiUrl('other = 1\napi_url = "https://c.example"\napi_url = "https://d.example"\n')).toBe("https://c.example");
  expect(parseApiUrl('api_url = ""\n')).toBe(null);
  expect(parseApiUrl('xapi_url = "https://e.example"\napi_url = "https://f.example" trailing\n')).toBe(null);
  expect(parseApiUrl('api_url = "https://g.example\n"')).toBe(null);
});

test("64 KiB of blank lines parses in linear time", () => {
  const started = performance.now();
  expect(parseApiUrl("\n".repeat(64 * 1024 - 1) + "x")).toBe(null);
  // A multiline ^\s* pattern took seconds here; the budget leaves room for a loaded host.
  expect(performance.now() - started).toBeLessThan(250);
});
