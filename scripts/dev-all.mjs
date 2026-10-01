// `npm run dev:all`: the API server and the app's dev server in one terminal.
// Each line is prefixed with its source; Ctrl-C, or either one exiting, stops both.

import { spawn } from "node:child_process";

const processes = [
  { name: "api", color: 35, args: ["run", "server"] },
  { name: "app", color: 36, args: ["run", "dev"] },
];

let stopping = false;
const children = processes.map(({ name, color, args }) => {
  const child = spawn("npm", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "1" } });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  for (const stream of [child.stdout, child.stderr]) {
    let rest = "";
    stream.on("data", (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop();
      // Once stopping, npm's complaints about the signal are noise.
      if (!stopping) for (const line of lines) process.stdout.write(`${prefix}${line}\n`);
    });
  }
  child.on("exit", (code) => {
    if (!stopping) {
      process.stdout.write(`${prefix}exited with code ${code}; stopping the other\n`);
      stop(code ?? 1);
    }
  });
  return child;
});

function stop(code = 0) {
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
