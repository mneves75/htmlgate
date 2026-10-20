#!/usr/bin/env node
// Prints an Instance's Cron Triggers from its config. Local and read-only: no network, writes nothing.
//
// Usage: node scripts/print-triggers.mjs --config <instance.json>
import { readInstance, workerConfig } from "./setup.mjs";

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--config" || !args[1]) {
    throw new Error("Usage: node scripts/print-triggers.mjs --config <instance.json>");
  }
  const inst = readInstance(args[1]);
  process.stdout.write(JSON.stringify(workerConfig(inst, { name: "placeholder", uuid: "placeholder" }, { open: true, vars: {} }).triggers) + "\n");
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
