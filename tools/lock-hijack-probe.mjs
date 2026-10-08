#!/usr/bin/env bun
/* R263c · MANUAL lock-hijack fault-injection probe (NOT in the gate suite).
 * Meta-mutation lesson: a flaky CI vector is worse than a coverage gap — this
 * probe is timing-dependent (tmpfs collapses fsync windows), so it runs ON
 * DEMAND against a chosen CLI + state dir, not in every CI pass.
 * Usage: SAOS_TEST_PERSIST_DELAY_MS=150 bun scripts/lock-hijack-probe.mjs <repo-root>
 * Expect: REFUSED: LOCK-LOST-MIDWRITE (the airtight net) · exit 0 on PASS.
 * The env seam is documented in task-console.mjs atomicWrite (inert by default). */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = process.argv[2] ?? process.cwd();
const PUB = fs.existsSync(path.join(REPO, "cli", "task-console.mjs"));
const CLI = path.join(REPO, PUB ? "cli/task-console.mjs" : "scripts/task-console.mjs");
const TASKS = path.join(REPO, PUB ? "state/tasks.json" : "mini-services/saos-engine/state/tasks.json");
fs.rmSync(path.dirname(TASKS), { recursive: true, force: true });
const LOCK = `${TASKS}.lock`;
const child = spawn(process.execPath, [CLI, "task-add", "hijacked", "--id", "T-HJ"], {
  stdio: ["ignore", "ignore", "inherit"],
  env: { ...process.env, SAOS_TEST_PERSIST_DELAY_MS: "150" },
});
let hijacked = false;
const poll = setInterval(() => {
  try {
    if (fs.statSync(LOCK).isFile()) {
      fs.renameSync(LOCK, LOCK + ".hijacked");
      fs.writeFileSync(LOCK, "999999 hijacker\n");
      hijacked = true;
      clearInterval(poll);
    }
  } catch { /* lock not born yet */ }
}, 1);
child.on("exit", (code) => {
  clearInterval(poll);
  try { fs.rmSync(LOCK + ".hijacked", { force: true }); } catch {}
  try { fs.rmSync(LOCK, { force: true }); } catch {}
  let landed = false;
  try { landed = JSON.parse(fs.readFileSync(TASKS, "utf8")).tasks.some((t) => t.id === "T-HJ"); } catch {}
  const pass = hijacked && code !== 0 && !landed;
  console.log(`LOCK-HIJACK ${pass ? "PASS" : "FAIL"} (hijacked=${hijacked} rc=${code} landed=${landed})`);
  process.exit(pass ? 0 : 1);
});
