// The CLI's version and the User-Agent it sends.
import { readFileSync } from "node:fs";
import { arch, platform } from "node:os";

export const VERSION: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

let agentName: string | null = null;

export function setAgent(name: string | null): void {
  agentName = name;
}

export function userAgent(): string {
  const base = `@htmlgate/cli/${VERSION} (node ${process.version}; ${platform()} ${arch()})`;
  return agentName ? base.replace(/\)$/, `; agent ${agentName})`) : base;
}
