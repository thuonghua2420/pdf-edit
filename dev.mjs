import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [
  spawn(npmCommand, ["run", "dev:client", "--", "--port", "5173"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  }),
  spawn(process.execPath, ["server.mjs"], {
    stdio: "inherit",
    shell: false,
  }),
];

function stop() {
  children.forEach((child) => child.kill());
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
children.forEach((child) => child.on("exit", (code) => {
  if (code && code !== 0) {
    process.exitCode = code;
  }
}));
