import { CliError } from "./errors.js";

const MAX_STDIN_BYTES = 4 * 1024;

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.byteLength;
    if (size > MAX_STDIN_BYTES) throw new CliError("invalid_token", "Stdin input is larger than an htmlgate token.");
    chunks.push(buf);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

export function readHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    let value = "";
    let done = false;
    const finish = (err?: CliError) => {
      if (done) return;
      done = true;
      stdin.off("data", onData);
      stdin.off("end", onCancel);
      stdin.off("close", onCancel);
      process.off("SIGINT", onCancel);
      process.off("SIGHUP", onCancel);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onCancel = () => finish(new CliError("cancelled", "Cancelled. Nothing was saved."));
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003" || ch === "\u0004") return onCancel();
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
    stdin.on("end", onCancel);
    stdin.on("close", onCancel);
    process.on("SIGINT", onCancel);
    process.on("SIGHUP", onCancel);
  });
}
