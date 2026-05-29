#!/usr/bin/env node
import { execSync } from "node:child_process";

const ports = [3000, 5173, 5174];

for (const port of ports) {
  try {
    const output = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();

    if (!output) {
      continue;
    }

    for (const pid of output.split("\n").filter(Boolean)) {
      process.kill(Number(pid), "SIGTERM");
    }

    console.log(`Freed port ${port}`);
  } catch {
    // Port is already free or lsof is unavailable.
  }
}
