// Reading a token without putting it on screen or in the shell history.
import { CliError } from "./errors.js";

/** All of stdin, for `login --token-stdin`. */
export async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/** One line typed on a terminal, not echoed. Ctrl-C cancels. */
export function readHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    let value = "";
    const finish = (err?: CliError) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003" || ch === "\u0004") return finish(new CliError("cancelled", "Cancelled. Nothing was saved."));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}
