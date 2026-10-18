// The CLI's side of sites and expiry, without an Instance: what `publish` reads from a folder or a .zip, and how
// `--expires` is read. The zip it makes is read back by the Instance's own reader (src/zip.ts).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { CliError } from "../packages/cli/src/errors";
import { loadPublishable, parseExpires } from "../packages/cli/src/files";
import { writeZip } from "../packages/cli/src/zip";
import { readSite } from "../src/zip";

const root = mkdtempSync(join(tmpdir(), "htmlgate-cli-site-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function folder(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

async function refusal(path: string): Promise<CliError> {
  const e = await loadPublishable(path).then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(CliError);
  return e as CliError;
}

describe("publishing a folder", () => {
  test("zips its files, leaving out every name that starts with a dot", async () => {
    const dir = folder("site", {
      "index.html": "<!doctype html><title>t</title>", "css/a.css": "p{}", ".env": "SECRET=1", ".git/config": "x", "img/.DS_Store": "x",
    });
    const { content } = await loadPublishable(dir);
    expect(content.kind).toBe("site");
    const site = await readSite((content as { zip: Uint8Array }).zip);
    expect(site.map((e) => e.path).sort()).toEqual(["css/a.css", "index.html"]);
  });

  test("refuses a symbolic link anywhere inside it", async () => {
    const dir = folder("linked", { "index.html": "x", "sub/a.txt": "a" });
    symlinkSync("/etc/hosts", join(dir, "sub", "hosts"));
    const e = await refusal(dir);
    expect(e.code).toBe("unsafe_path");
    expect(e.message).toContain("symbolic link");
  });

  test("refuses a folder without index.html at its top", async () => {
    const e = await refusal(folder("noindex", { "page.html": "x" }));
    expect(e.code).toBe("site_invalid");
  });

  test("sends a .zip as it is, and a page as HTML", async () => {
    const zip = writeZip([{ path: "index.html", data: new TextEncoder().encode("x") }]);
    writeFileSync(join(root, "ready.zip"), zip);
    const z = await loadPublishable(join(root, "ready.zip"));
    expect(z.content).toEqual({ kind: "site", zip: new Uint8Array(zip) });
    writeFileSync(join(root, "page.html"), "<p>hi</p>");
    expect((await loadPublishable(join(root, "page.html"))).content).toEqual({ kind: "page", html: "<p>hi</p>" });
  });
});

describe("--expires", () => {
  const now = Date.UTC(2026, 9, 9, 12, 0, 0);
  test.each([
    ["never", null],
    ["30d", now + 30 * 86_400_000],
    ["12h", now + 12 * 3_600_000],
    ["2026-12-31", Date.UTC(2026, 11, 31)],
    ["2026-12-31T18:00:00Z", Date.UTC(2026, 11, 31, 18)],
    ["2026-12-31T18:00:00-03:00", Date.UTC(2026, 11, 31, 21)],
  ])("%j", (raw, at) => {
    expect(parseExpires(raw, now)).toBe(at);
  });

  test.each(["", "0d", "30", "30m", "tomorrow", "2026-13-40", "2026-12-31T18:00:00"])("%j is refused", (raw) => {
    expect(() => parseExpires(raw, now)).toThrow(CliError);
  });
});
