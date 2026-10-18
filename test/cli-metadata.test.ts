import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

test.each([false, true])("CLI publication (upsert=%s) preserves literal metadata keys and last-value duplicates", async (upsert) => {
  let payload: unknown;
  let query: Record<string, string> | undefined;
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      query = Object.fromEntries(new URL(req.url!, "http://localhost").searchParams);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [], pagination: { total: 0, total_pages: 0 } }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    payload = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ slug: "Metadata0001", title: "metadata", description: null, metadata: {}, url: "https://instance.example/s/Metadata0001", public: false, latest_version: 1, updated_at: 1, created_at: 1 }));
  });
  const dir = mkdtempSync(join(tmpdir(), "htmlgate-cli-metadata-"));
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    writeFileSync(join(dir, "page.html"), "<p>test</p>");
    await promisify(execFile)(process.execPath, [join(process.cwd(), "packages/cli/dist/bin.js"), "--output", "json", "publish", join(dir, "page.html"), ...(upsert ? ["--upsert"] : []), "--title", "metadata", "--metadata", "__proto__=literal", "--metadata", "constructor=value", "--metadata", "toString=text", "--metadata", "normal=first", "--metadata", "normal=last"], {
      env: { PATH: process.env.PATH, HTMLGATE_URL: `http://127.0.0.1:${port}`, HTMLGATE_TOKEN: "hg_" + "T".repeat(40) },
    });
    expect(payload).toMatchObject({ metadata: Object.fromEntries([["__proto__", "literal"], ["constructor", "value"], ["toString", "text"], ["normal", "last"]]) });
    if (upsert) expect(query).toMatchObject({ "metadata.__proto__": "literal", "metadata.constructor": "value", "metadata.toString": "text", "metadata.normal": "last" });
  } finally {
    server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
