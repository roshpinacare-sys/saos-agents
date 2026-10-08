#!/usr/bin/env bun
/* R259 · cli-contract — spawn-based contract tests for the CLI artifact itself.
 *
 * Module selftests prove the pure logic; this suite proves the SHIPPED COMMAND:
 * exit codes {0,1,2}, REFUSED honesty (no raw stack traces on stderr), validate-before-persist
 * (bad input never poisons the store), fresh-clone grace, corrupt-file quarantine, the writer
 * lock (busy + stale-steal), crash-orphan sweep, the done-gate, and a 12-writer race.
 *
 * RUN: bun scripts/cli-contract.mjs   (private tree)  ·  bun test/cli-contract.mjs  (open tree)
 * Layout auto-detected: ../cli/task-console.mjs + ../src/*.mjs  OR  ../scripts/task-console.mjs
 * + ../mini-services/saos-engine/*.mjs. Each run builds its own throwaway sandbox in os.tmpdir().
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync, readdirSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const PUB = existsSync(path.join(REPO, "cli", "task-console.mjs"));
const CLI_REL = PUB ? "cli/task-console.mjs" : "scripts/task-console.mjs";
const MOD_RELS = PUB
  ? ["src/taskgraph.mjs", "src/decisionqueue.mjs"]
  : ["mini-services/saos-engine/taskgraph.mjs", "mini-services/saos-engine/decisionqueue.mjs"];
const STATE_REL = PUB ? "state" : "mini-services/saos-engine/state";

let pass = 0, fail = 0;
const eq = (name, a, b) => {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja === jb) pass++;
  else { fail++; console.error(`FAIL ${name}\n  got: ${ja}\n  want: ${jb}`); }
};
const ok = (name, cond) => (cond ? pass++ : (fail++, console.error(`FAIL ${name}`)));

function sandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), "tc-contract-"));
  for (const rel of [CLI_REL, ...MOD_RELS]) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    cpSync(path.join(REPO, rel), path.join(root, rel));
  }
  return root;
}
const stateFile = (root, name) => path.join(root, STATE_REL, name);
function run(root, args) {
  const r = spawnSync(process.execPath, [path.join(root, CLI_REL), ...args], { encoding: "utf8" });
  return { rc: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}
const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);

/* ── lifecycle on one sandbox ── */
{
  const root = sandbox();
  const TASKS = stateFile(root, "tasks.json");
  eq("fresh clone: tasks graceful (no ENOENT)", run(root, ["tasks"]).rc, 0);
  ok("fresh clone: zero tasks reported", /tasks: 0/.test(run(root, ["tasks"]).out));
  const j = run(root, ["tasks", "--json"]);
  eq("fresh clone: --json channel parses", JSON.parse(j.out).tasks.length, 0);
  ok("fresh clone: no stderr noise on clean start", run(root, ["tasks"]).err === "");

  eq("task-add: accepted", run(root, ["task-add", "ראשונה-עברית שלום"]).rc, 0);
  ok("task-add: state file valid JSON on disk", JSON.parse(readIf(TASKS)).tasks.length === 1);
  ok("task-add: unicode title roundtrips intact", run(root, ["tasks"]).out.includes("ראשונה-עברית שלום"));

  const beforeGhost = readIf(TASKS);
  const ghost = run(root, ["task-add", "B", "--deps", "GHOST-9"]);
  eq("ghost dep: refused rc=1", ghost.rc, 1);
  ok("ghost dep: named INVALID-STATE refusal", ghost.err.startsWith("REFUSED: INVALID-STATE"));
  eq("ghost dep: state byte-identical (nothing persisted)", readIf(TASKS), beforeGhost);

  eq("dup id: first --id accepted (title-first, the documented order)", run(root, ["task-add", "first", "--id", "T-DUP"]).rc, 0);
  const beforeDup = readIf(TASKS);
  const dup = run(root, ["task-add", "second", "--id", "T-DUP"]);
  eq("dup id: second refused rc=1", dup.rc, 1);
  ok("dup id: named INVALID-STATE refusal", dup.err.includes("כפילות-id"));
  eq("dup id: state byte-identical", readIf(TASKS), beforeDup);

  const beforeFlags = readIf(TASKS);
  const flagsFirst = run(root, ["task-add", "--id", "T-Y", "real-title"]);
  eq("flags-first title: refused (no silent \"--id\" title)", flagsFirst.rc, 1);
  eq("flags-first title: state untouched", readIf(TASKS), beforeFlags);

  eq("illegal transition: todo→review refused", run(root, ["task-set", "T-DUP", "review"]).rc, 1);
  eq("illegal transition: named", run(root, ["task-set", "T-DUP", "review"]).err.includes("ILLEGAL-TRANSITION"), true);
  eq("CLI gate order: done on a todo task speaks DONE-GATE first (by design)", run(root, ["task-set", "T-DUP", "done"]).err.includes("DONE-GATE-REFUSED"), true);
  eq("done-gate: no commit refused", run(root, ["task-set", "T-DUP", "doing"]) && run(root, ["task-set", "T-DUP", "done"]).rc, 1);
  ok("done-gate: named DONE-GATE-REFUSED", run(root, ["task-set", "T-DUP", "done"]).err.includes("DONE-GATE-REFUSED"));
  ok("done-gate: commit without push evidence refused", run(root, ["task-set", "T-DUP", "done", "--commit", "sha-abc123"]).err.includes("DONE-GATE-REFUSED"));

  const idA = JSON.parse(run(root, ["tasks", "--json"]).out).tasks[0].id;
  eq("deps happy-path: B with real dep accepted", run(root, ["task-add", "B", "--deps", idA]).rc, 0);
  eq("deps happy-path: ready holds B until A done", JSON.parse(run(root, ["tasks", "--json"]).out).ready.length, 1);

  writeFileSync(TASKS, "CORRUPT{{{");
  const corr = run(root, ["tasks"]);
  eq("corrupt file: tasks still graceful rc=0", corr.rc, 0);
  ok("corrupt file: quarantined aside", readdirSync(stateFile(root, ".")).some((e) => e.startsWith("tasks.json.corrupt-")));
  ok("corrupt file: clean start afterwards", /tasks: 0/.test(corr.out));

  rmSync(root, { recursive: true, force: true });
}

/* ── lock semantics + crash-orphan sweep ── */
{
  const root = sandbox();
  const TASKS = stateFile(root, "tasks.json");
  eq("seed task", run(root, ["task-add", "seed"]).rc, 0);
  mkdirSync(stateFile(root, "."), { recursive: true });
  writeFileSync(`${TASKS}.lock`, `${process.pid} live-owner`); // a LIVE pid (this runner) must be honored
  const t0 = Date.now();
  const busy = run(root, ["task-add", "blocked"]);
  const elapsed = Date.now() - t0;
  eq("lock busy: refused rc=1", busy.rc, 1);
  ok("lock busy: named LOCK-BUSY (never silence)", busy.err.includes("LOCK-BUSY"));
  ok("lock busy: waited the patience window before refusing (>=1.8s — kills wait=0)", elapsed >= 1800);

  utimesSync(`${TASKS}.lock`, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const steal = run(root, ["task-add", "stolen"]);
  eq("stale lock: steal succeeds", steal.rc, 0);
  eq("stale lock: original lock path released", existsSync(`${TASKS}.lock`), false);

  writeFileSync(`${TASKS}.tmp-999999`, "junk");
  utimesSync(`${TASKS}.tmp-999999`, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  eq("orphan tmp: write succeeds over it", run(root, ["task-add", "after-crash"]).rc, 0);
  eq("orphan tmp: swept by next write", existsSync(`${TASKS}.tmp-999999`), false);

  /* R259 · owner-liveness (SIGKILL recovery): a lock whose owner pid is DEAD is stolen instantly —
   * no 30s write blackout (measured: final write after a kill-storm was LOCK-BUSY before this). */
  writeFileSync(`${TASKS}.lock`, "999999999 dead-owner");
  eq("orphan lock (dead pid, fresh mtime): stolen instantly", run(root, ["task-add", "after-sigkill"]).rc, 0);
  writeFileSync(`${TASKS}.lock`, `${process.pid} live-owner`);
  eq("live-owner lock: honored (pid probe must not steal live writers)", run(root, ["task-add", "live-blocked"]).rc, 1);
  writeFileSync(`${TASKS}.lock`, ""); // killed between lock-create and pid-write
  eq("empty-owner lock: writer recovers via the grace law (~250ms, then steal)", run(root, ["task-add", "grace-window"]).rc, 0);
  rmSync(root, { recursive: true, force: true });
}

/* ── decision queue: validate-before-persist + full lifecycle ── */
{
  const root = sandbox();
  const DQ = stateFile(root, "decisions.json");
  eq("decisions: fresh clone graceful", run(root, ["decisions"]).rc, 0);
  eq("decision-add: accepted (explicit id)", run(root, ["decision-add", "question", "לאיזה-כיוון?", "כן", "לא", "--id", "D-1"]).rc, 0);
  const dqState = readIf(DQ);
  const dupD = run(root, ["decision-add", "question", "שוב", "א", "ב", "--id", "D-1"]);
  eq("decision-add: duplicate --id refused", dupD.rc, 1);
  ok("decision-add: named INVALID-STATE refusal", dupD.err.startsWith("REFUSED: INVALID-STATE"));
  eq("decision-add: state byte-identical after refusal", readIf(DQ), dqState);
  const idD = JSON.parse(run(root, ["decisions", "--json"]).out).decisions[0].id;
  eq("decision-answer: unknown option refused", run(root, ["decision-answer", idD, "אולי"]).rc, 1);
  eq("decision-answer: valid option accepted", run(root, ["decision-answer", idD, "כן"]).rc, 0);
  eq("decision-settle: after answer accepted", run(root, ["decision-settle", idD]).rc, 0);
  eq("decision-reopen: with reason accepted", run(root, ["decision-reopen", idD, "Merge refused: בדיקה"]).rc, 0);
  ok("decision lifecycle: history preserved", readIf(DQ).includes("Merge refused: בדיקה"));
  rmSync(root, { recursive: true, force: true });
}

/* ── exit-code domain: curated adversarial argv matrix ── */
{
  const root = sandbox();
  const MATRIX = [
    ["task-add"], ["task-add", ""], ["task-add", "x", "--priority", "abc"], ["task-add", "x", "--priority"],
    ["task-add", "x", "--deps", ","], ["task-set"], ["task-set", "X"], ["task-set", "X", "zap"],
    ["task-set", "GHOST", "doing"], ["decision-add"], ["decision-add", "bogus", "q"], ["decision-add", "question", "q"],
    ["decision-add", "question", "q", ""], ["decision-answer"], ["decision-answer", "NOPE", "1"],
    ["decision-settle", "NOPE"], ["decision-reopen", "NOPE", "r"], ["decision-cancel", "NOPE", "r"],
    ["tasks", "--json", "extra"], ["--help"], ["bogus"], ["task-add", "x", "--json"], ["drill", "--seed", "abc"],
    ["progress", "--json"], ["decisions", "--json"], ["task-add", "ok-title", "--priority", "3", "--json"],
  ];
  const results = MATRIX.map((argv) => run(root, argv));
  eq("argv matrix: exit codes stay within {0,1,2}", results.every((r) => [0, 1, 2].includes(r.rc)), true);
  ok("argv matrix: every rc=1 speaks REFUSED (no raw crash)", results.every((r) => r.rc !== 1 || r.err.startsWith("REFUSED:")));
  const stacks = results.filter((r) => /^\s+at /m.test(r.err)).length;
  eq("argv matrix: zero raw stack traces leak to stderr", stacks, 0);
  ok("argv matrix: rc=2 prints help", results.every((r) => r.rc !== 2 || r.out.includes("commands:")));
  eq("drill --json channel parses", JSON.parse(run(root, ["drill", "--json"]).out).ok, true);
  rmSync(root, { recursive: true, force: true });
}

/* ── race: 12 concurrent writers, zero lost updates ── */
{
  const root = sandbox();
  const TASKS = stateFile(root, "tasks.json");
  const procs = Array.from({ length: 12 }, (_, i) =>
    spawnSync(process.execPath, [path.join(root, CLI_REL), "task-add", `racer-${i}`], { encoding: "utf8" }));
  const survivorsN = procs.filter((p) => p.status === 0).length;
  eq("race: 12/12 writers survive", survivorsN, 12);
  const onDisk = JSON.parse(readIf(TASKS)).tasks;
  eq("race: 12/12 tasks on disk", onDisk.length, 12);
  eq("race: 12/12 unique ids", new Set(onDisk.map((t) => t.id)).size, 12);
  eq("race: no tmp orphans left", readdirSync(stateFile(root, ".")).filter((e) => e.includes(".tmp-")).length, 0);
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nCLI-CONTRACT ${pass}/${pass + fail} ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
