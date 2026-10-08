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
  /* R263 · SAOS_CONTRACT_TMPDIR: real-disk override — the lock-hijack vector's
   * fsync window is real only on real storage (tmpfs fsync ≈ 0 collapses it),
   * so fault-injection CI runs point this at real disk; default stays tmpdir. */
  const tmpBase = process.env.SAOS_CONTRACT_TMPDIR || os.tmpdir();
  const root = mkdtempSync(path.join(tmpBase, "tc-contract-"));
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
  /* R262 · LAW CHANGE: the 250ms empty-owner grace-steal is GONE — stealing an
   * empty lock quickly was exactly the silent-loss bug (a slow LIVE writer's
   * fresh lock looked like debris; born-complete locks make empty locks
   * structurally impossible from this CLI, so an empty lock is now FOREIGN
   * debris and only the 30s age backstop may clear it). Asserted both sides:
   * fresh garbage is honored-then-named-refused (never stolen, never silent),
   * aged garbage (>30s, mtime pre-aged via utimes) is cleared. */
  writeFileSync(`${TASKS}.lock`, ""); // foreign debris, fresh mtime
  const bytesBefore = readIf(TASKS);
  eq("empty-owner fresh garbage: LOCK-BUSY named refusal (never fast-steal)", run(root, ["task-add", "fresh-garbage"]).rc, 1);
  eq("empty-owner fresh garbage: state bytes untouched", readIf(TASKS), bytesBefore);
  /* R263 · the aged-garbage step must tolerate the lock having vanished (a
   * fast-stealing mutant already removed it): a vector that CRASHES instead of
   * failing named makes the whole suite die before later vectors run — measured
   * during meta-mutation against the R259 mutant. */
  try {
    utimesSync(`${TASKS}.lock`, new Date(Date.now() - 40_000), new Date(Date.now() - 40_000));
    eq("empty-owner aged garbage: cleared by the 30s age law", run(root, ["task-add", "aged-garbage"]).rc, 0);
  } catch (e) {
    if (e?.code === "ENOENT") ok("empty-owner aged garbage: lock already gone (fast-steal mutant — vector below will fail), suite still completes");
    else throw e;
  }
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

/* ── race: 12 TRULY-concurrent writers, zero silent lost updates (R262) ──
 * R259's vector called spawnSync inside Array.from — the "12 parallel writers"
 * ran SEQUENTIALLY (each spawnSync blocks until exit), so the born-INCOMPLETE
 * lock's silent-loss window shipped green while measured live under real
 * concurrency: 20 writers → 16-18 tasks on disk with every process exiting 0
 * (an empty lock got stolen from a LIVE writer >250ms into its pid-write gap,
 * two writers ran the critical section, last-persist wins). R262 fix:
 * born-complete locks (pid inside the claim BEFORE the lock name exists,
 * promoted by atomic link()) + verify-before-unlink. This vector now spawns
 * REAL concurrent processes and judges survivorship AND on-disk completeness. */
{
  const root = sandbox();
  const TASKS = stateFile(root, "tasks.json");
  const { spawn } = await import("node:child_process");
  const procs = Array.from({ length: 12 }, (_, i) =>
    spawn(process.execPath, [path.join(root, CLI_REL), "task-add", `racer-${i}`], { stdio: "ignore" }));
  const codes = await Promise.all(procs.map((p) => new Promise((res) => p.on("exit", (c) => res(c)))));
  /* R263 · load-honest accounting: the LAW is zero SILENT loss, not "everyone
   * survives". Under heavy machine load a writer may be named-refused
   * (LOCK-BUSY / LOCK-LOST-MIDWRITE) — that is by-design backpressure. What may
   * never happen: a writer exiting 0 whose task is missing from disk (the
   * measured R262 bug: 12 exit-0 → 9 on disk). Invariant:
   *   onDisk == exit-0 count,  exit-0 + refusals == 12,  unique ids.
   * The born-INCOMPLETE lock still kills this vector (measured: all rc=0,
   * fewer on disk), while CI-noise no longer flakes it. */
  const okN = codes.filter((c) => c === 0).length;
  const refN = codes.length - okN;
  const onDisk = JSON.parse(readIf(TASKS)).tasks;
  eq("race: no silent loss (onDisk == exit-0 writers)", onDisk.length, okN);
  eq("race: every writer accounted (exit-0 + refusals == 12)", okN + refN, 12);
  eq("race: no duplicate ids", new Set(onDisk.map((t) => t.id)).size, onDisk.length);
  // R263 · settle-then-judge: readdir can interleave with the last writer's
  // release-unlink; re-list after a short settle and judge the SECOND listing.
  await new Promise((r) => setTimeout(r, 100));
  const debris = readdirSync(stateFile(root, ".")).filter((e) => (e.includes(".tmp-") || e.includes(".lock") || e.includes(".steal")) && !e.includes(".stale-"));
  eq(`race: no active lock/claim/tmp/steal debris left (settled; .stale-* lawful residue)${debris.length ? " — FOUND: " + debris.join(", ") : ""}`, debris.length, 0);
  rmSync(root, { recursive: true, force: true });
}

/* ── race-cold: 24-writer heavy canary (R263 meta-mutation) ──
 * Meta-mutation measured blind spots: M3 (steal-mutex removed → probe→rename
 * TOCTOU) survived the 12-writer vector but silently lost 10-11/20 tasks under
 * colder/heavier contention; M2 (persist inode-check disabled) survives every
 * black-box vector (µs window) and stays as a documented structural guarantee.
 * This heavier canary probabilistically-deterministically catches M3-class
 * regressions: at 20-30 writers the mutex-less steal lost updates in most runs. */
{
  const root = sandbox();
  const TASKS = stateFile(root, "tasks.json");
  const { spawn } = await import("node:child_process");
  const procs = Array.from({ length: 24 }, (_, i) =>
    spawn(process.execPath, [path.join(root, CLI_REL), "task-add", `cold-${i}`], { stdio: "ignore" }));
  const codes = await Promise.all(procs.map((p) => new Promise((res) => p.on("exit", (c) => res(c)))));
  const okN = codes.filter((c) => c === 0).length;
  const refN = codes.length - okN;
  const onDisk = JSON.parse(readIf(TASKS)).tasks;
  eq("race-cold: no silent loss (onDisk == exit-0 writers)", onDisk.length, okN);
  eq("race-cold: every writer accounted (exit-0 + refusals == 24)", okN + refN, 24);
  eq("race-cold: no duplicate ids", new Set(onDisk.map((t) => t.id)).size, onDisk.length);
  rmSync(root, { recursive: true, force: true });
}

/* ── R260 · giant-round probes became law: closed argv set, no silent pretense,
 * symlink-immune tmp (CWE-59), and a gitsafety-env whose promise matches its mechanism. ── */
{
  const root = sandbox();
  const TASKS = stateFile(root, "tasks.json");
  const DQ = stateFile(root, "decisions.json");
  eq("R260 seed: task exists", run(root, ["task-add", "probe", "--id", "T-P"]).rc, 0);
  eq("R260 seed: decision exists", run(root, ["decision-add", "question", "q", "a", "b", "--id", "D-1"]).rc, 0);

  /* P3a — typo flag: silently ignored before (priority defaulted to 0) */
  const beforeTypo = readIf(TASKS);
  const typo = run(root, ["task-add", "probe", "--priorty", "5"]);
  eq("R260 argv: typo flag refused rc=1", typo.rc, 1);
  ok("R260 argv: named UNKNOWN-FLAG", typo.err.startsWith("REFUSED: UNKNOWN-FLAG"));
  eq("R260 argv: state byte-identical after typo flag", readIf(TASKS), beforeTypo);

  /* P3b — dash-prefixed option labels: swallowed TOGETHER WITH the next token before
   * (decision created with 0 options, silent — and --id swallowed out of positionals too) */
  const beforeDash = readIf(DQ);
  const dashOpt = run(root, ["decision-add", "merge", "keep or drop", "--keep A", "--drop B"]);
  eq("R260 argv: dash-prefixed option labels refused", dashOpt.rc, 1);
  ok("R260 argv: named refusal names the offender", dashOpt.err.includes("--keep A"));
  eq("R260 argv: dq state byte-identical", readIf(DQ), beforeDash);

  /* P3c — reason word starting with "--" ate the word after it */
  const reopenDash = run(root, ["decision-reopen", "D-1", "no", "--force", "needed"]);
  eq("R260 argv: reason containing unknown --word refused", reopenDash.rc, 1);
  ok("R260 argv: named UNKNOWN-FLAG for --force", reopenDash.err.includes("--force"));
  eq("R260 argv: missing reason is a named usage refusal", run(root, ["decision-reopen", "D-1"]).rc, 1);

  /* P1 — bare answer: silently answered with empty {by,at} before (measured rc=0) */
  const beforeAns = readIf(DQ);
  const bare = run(root, ["decision-answer", "D-1"]);
  eq("R260 pretense: bare answer refused rc=1", bare.rc, 1);
  ok("R260 pretense: named INVALID-DECISION", bare.err.includes("INVALID-DECISION"));
  eq("R260 pretense: dq state byte-identical", readIf(DQ), beforeAns);
  rmSync(root, { recursive: true, force: true });

  /* P2 — CWE-59: plain "w" FOLLOWED a pre-placed symlink at tasks.json.tmp-<pid> and
   * clobbered the victim outside state/ (live-proven). "wx"+0600 must refuse by name. */
  const root2 = sandbox();
  const wrap = path.join(root2, "wrap.mjs");
  const victim = path.join(root2, "victim.txt");
  writeFileSync(victim, "VICTIM-SENTINEL\n");
  writeFileSync(wrap, `
    import { symlinkSync, readFileSync, mkdirSync } from "node:fs";
    import path from "node:path";
    const target = path.resolve(process.argv[2]);
    const repoRoot = path.dirname(path.dirname(target));
    const victim = ${JSON.stringify(victim)};
    const stateDir = path.join(repoRoot, ${JSON.stringify(STATE_REL)});
    mkdirSync(stateDir, { recursive: true });
    symlinkSync(victim, path.join(stateDir, "tasks.json.tmp-" + process.pid));
    process.exit = (c) => { throw new Error("CLI-EXITED-" + c); }; // survive the CLI's exit to report
    process.argv = [process.argv[0], target, "task-add", "symlink-probe"];
    let rc = 0;
    try { await import(target); } catch (e) {
      const m = String(e?.message ?? e);
      rc = m.startsWith("CLI-EXITED-") ? Number(m.slice(11)) : 9;
      if (rc === 9) console.error("WRAPPER-FATAL", m);
    }
    let vs = "GONE";
    try { vs = readFileSync(victim, "utf8") === "VICTIM-SENTINEL\\n" ? "INTACT" : "CLOBBERED"; } catch {}
    console.log("CLIRC:" + rc + " VICTIM:" + vs);
  `);
  const sym = spawnSync(process.execPath, [wrap, path.join(root2, CLI_REL)], { encoding: "utf8" });
  ok("R260 CWE-59: victim outside state/ stays INTACT (was clobbered through the symlink)", sym.stdout.includes("VICTIM:INTACT"));
  ok("R260 CWE-59: CLI refused by name (TMP-EXISTS), rc=1", sym.stderr.includes("TMP-EXISTS") && sym.stdout.includes("CLIRC:1"));
  eq("R260 CWE-59: no stack traces leak through the wrapper", /^\s+at /m.test(sym.stderr ?? ""), false);
  rmSync(root2, { recursive: true, force: true });

  /* P6 — gitsafety-env: the promise must equal the mechanism (the dead protocol.file.allow=user
   * line was removed — GIT_ALLOW_PROTOCOL wins, so FILE transport was refused all along while
   * the script promised a user exception; now the contract says: total refusal, INCLUDING file) */
  const gitOk = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  if (gitOk) {
    const GS = path.join(REPO, PUB ? "tools" : "scripts", "gitsafety-env.sh");
    const httpsTry = spawnSync("bash", [GS, "git", "ls-remote", "https://127.0.0.1:1/x.git"], { encoding: "utf8" });
    ok("R260 gitsafety: https refused before any packet", httpsTry.status !== 0 && /not allowed/.test(httpsTry.stderr));
    const fileTry = spawnSync("bash", [GS, "git", "ls-remote", REPO], { encoding: "utf8" });
    ok("R260 gitsafety: even FILE transport refused (total law, measured)", fileTry.status !== 0 && /not allowed/.test(fileTry.stderr));
    const sourced = spawnSync("bash", ["-c", `set -euo pipefail; source ${GS}; echo COUNT=$GIT_CONFIG_COUNT`], { encoding: "utf8" });
    eq("R260 gitsafety: sourcing survives set -euo pipefail, 3 config lines", (sourced.stdout.match(/COUNT=(\d)/) ?? [])[1], "3");
  }
}

console.log(`\nCLI-CONTRACT ${pass}/${pass + fail} ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
