#!/usr/bin/env bun
/* R253 · task-console — המסוף-הריבוני-למשימות-והחלטות (זיקוק-מ-agentcraft, גל-2+3).
 *
 * חוקי-ברזל:
 *  · done-only-via-verified-push — ה-CLI מחשב-ראיות-אמת מהעץ:
 *      selftest-last-run.json (fail==0 + טריות<24h) + push-custody.json (דחיפה-טרייה-דרך-השער)
 *  · פעולות-מפעיל יוצאות-כהחלטות (decisions) — לא-עוצרות-בשקט
 *  · persist אטומי (temp+rename) לתוך state/ — מסילת-ה-custodian משמרת-אותם-בגיט
 *  · --json = הערוץ-המכונתי-לקונסול-החי
 *
 * RUN (bun or node ≥ 18):
 *   bun cli/task-console.mjs tasks|progress|decisions [--json]
 *   bun cli/task-console.mjs task-add "<title>" [--priority N] [--deps a,b] [--assignee X]
 *   bun cli/task-console.mjs task-set <id> <status> [--commit SHA] [--reason "..."]
 *   bun cli/task-console.mjs decision-add <kind> "<question>" "<opt1>" "<opt2>"...
 *   bun cli/task-console.mjs decision-answer <id> <1|text> [--by name] [--text "..."]
 *   bun cli/task-console.mjs decision-settle <id> | decision-reopen <id> "<reason>" | decision-cancel <id> "<reason>"
 *   bun cli/task-console.mjs drill [--seed N] [--json]
 */
import {
  createTask, setStatus, ready, progress, validateGraph, deserialize,
  runDrill, STATUSES,
} from "../src/taskgraph.mjs";
import {
  createDecision, answerDecision, settleDecision, reopenDecision, cancelDecision,
  listOpen, deserializeDQ, validateDQ,
} from "../src/decisionqueue.mjs";
import { readFileSync, renameSync, existsSync, mkdirSync, openSync, writeSync, closeSync, unlinkSync, statSync, readdirSync, fsyncSync, linkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATE = path.join(ROOT, "state");
const TASKS_FILE = path.join(STATE, "tasks.json");
const DQ_FILE = path.join(STATE, "decisions.json");
const SELFTEST_FILE = path.join(STATE, "selftest-last-run.json");
const PUSH_FILE = path.join(STATE, "push-custody.json");

const args = process.argv.slice(2);
const cmd = args[0] ?? "";
/* R260 · the argv contract is a CLOSED set — measured live: a typo flag (--priorty) was
 * silently ignored (priority defaulted to 0), option labels starting with "--" were
 * swallowed TOGETHER WITH the next token (decision-add "--keep A" "--drop B" → 0 options,
 * silent), and a reason word starting with "--" ate the word after it. Named refusal ≥
 * silent swallowing. */
const KNOWN_FLAGS = new Set(["--json", "--priority", "--deps", "--assignee", "--id", "--commit", "--reason", "--by", "--text", "--seed", "--help"]);
const VALUE_FLAGS = new Set(["--priority", "--deps", "--assignee", "--id", "--commit", "--reason", "--by", "--text", "--seed"]);
const has = (f) => args.includes(f);
const flagVal = (f) => {
  const i = args.indexOf(f);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v === undefined || v.startsWith("--") ? undefined : v; // never swallow a following flag as a value
};
const FRESH_MS = 24 * 60 * 60 * 1000;

/* R259 · fsync before rename: rename is atomic against other processes, but against power
 * loss the content may never reach the platter — fsync closes that failure family (SQLite-style). */
function atomicWrite(file, content) {
  mkdirSync(path.dirname(file), { recursive: true }); // fresh clone: state/ does not exist yet
  const tmp = `${file}.tmp-${process.pid}`;
  let fd;
  try {
    /* R260 · "wx" + 0600 (O_EXCL): measured — plain "w" FOLLOWS a pre-placed symlink at
     * tmp-<pid> and clobbers the victim it points at (CWE-59, live-proven with a same-pid
     * wrapper: a file outside state/ was overwritten with the state JSON). O_EXCL refuses
     * any existing entry — symlink or crash debris — and 0600 keeps the half-written
     * state private. */
    fd = openSync(tmp, "wx", 0o600);
  } catch (e) {
    if (e.code === "EEXIST") throw new Error(`TMP-EXISTS: ${path.basename(tmp)} already exists (symlink-or-debris) — refused by name, never bypassed; debris older than 60s is swept by sweepTmp`);
    throw e;
  }
  try {
    try { writeSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    /* R263 · TEST-ONLY SEAM (inert by default): a deterministic fault-injection
     * window for the contract's lock-hijack vector — yields BEFORE the ownership
     * check so the external hijacker can swap the lock mid-critical-section.
     * No effect unless SAOS_TEST_PERSIST_DELAY_MS is set by the test. */
    const injectDelay = Number(process.env.SAOS_TEST_PERSIST_DELAY_MS ?? 0);
    if (injectDelay > 0) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, injectDelay); } catch { /* no blocking */ } }
  /* R262c · final ownership check (the airtight net): the rename crosses only if the
   * lock name still points at MY claim's inode. Two writers can never BOTH pass —
   * the name has one inode and each claim is its own unique inode — so any residual
   * race becomes a NAMED refusal (LOCK-LOST-MIDWRITE), never a silent loss. */
  if (ACTIVE_LOCK && ACTIVE_LOCK.file === file) {
    let ino = null;
    try { ino = statSync(`${file}.lock`).ino; } catch { /* lock vanished — refuse */ }
    if (ino !== ACTIVE_LOCK.ino) throw new Error(`LOCK-LOST-MIDWRITE: ${path.basename(file)} — the lock changed under us mid-write; refusing by name (re-run), never a silent loss`);
  }
    renameSync(tmp, file);
  } catch (e) {
    /* R263 · failure hygiene: a refused writer (LOCK-LOST-MIDWRITE / write error)
     * must not leave its tmp orphaned behind — the refusal is named and the
     * sandbox stays clean (measured: refusals left tasks.json.tmp-<pid> orphans
     * that flaked the debris vector). */
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
  sweepTmp(file);
}
/* R259 · crash-orphan hygiene: SIGKILL between write and rename leaves `file.tmp-<pid>` behind
 * forever. Safe by construction: the per-file writer lock serializes writers, so any *.tmp-*
 * older than 60s belongs to a dead process (measured, SIGKILL ×40). */
function sweepTmp(file) {
  try {
    const dir = path.dirname(file);
    for (const e of readdirSync(dir)) {
      if (!e.startsWith(`${path.basename(file)}.tmp-`)) continue;
      const p = path.join(dir, e);
      try { if (Date.now() - statSync(p).mtimeMs > 60_000) unlinkSync(p); } catch { /* raced — next sweep */ }
    }
  } catch { /* dir gone — nothing to sweep */ }
}
function loadJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    // הסגר-בסגנון-המקור: לא crash-loop — קובץ-קורום מועבר-לצד-ומתחיל-נקי
    if (!existsSync(file)) return fallback; // R259: another reader quarantined it first (reader race — no ENOENT crash)
    const quarantine = `${file}.corrupt-${Date.now()}-${process.pid}`; // pid suffix: collision-proof id (R258 lesson)
    try { renameSync(file, quarantine); } catch { return fallback; } // vanished mid-quarantine — start clean
    console.error(`[task-console] corrupt file quarantined: ${path.basename(quarantine)}`);
    return fallback;
  }
}

/* Positionals: skip only KNOWN value-flags (+ their value) — R260: everything reaching
 * here already passed the UNKNOWN-FLAG gate, so what remains is content or a known
 * value-flag. No silent swallowing. */
function positional(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (VALUE_FLAGS.has(list[i])) { i++; continue; }
    out.push(list[i]);
  }
  return out;
}

/* Writer lock: atomic rename prevents corruption but NOT lost updates — measured live
 * (20 parallel task-adds → 11 survivors; read-modify-write is not transactional across
 * processes).
 *
 * R262 · BORN-COMPLETE LOCKS (the surprise-round fix, measured live): the R259 lock
 * was created EMPTY (O_EXCL) and its owner pid written AFTER acquisition
 * ("informational only") — a µs window that became REAL under cold 20-way
 * contention: a contender read an empty owner, aged it >250ms, STOLE a LIVE
 * writer's lock, two writers ran the critical section → silent lost updates with
 * every process exiting rc=0 (measured: 20 writers → 16-18 tasks, zero errors).
 * Fix: the pid is written into a private claim file FIRST and link() promotes it
 * to the lock name atomically — a lock can never exist without its owner pid
 * inside (empty-owner fast-steal removed; the 30s age backstop covers foreign
 * debris). Release verifies ownership before unlink — a stolen lock is never a
 * stranger's to delete. Steals run under a steal-mutex + inode re-verify (a
 * probe→rename gap otherwise lets a live successor's lock be destroyed — caught
 * live in the decision log). And the airtight net: persist re-verifies the lock
 * inode right before its atomic rename — two writers can never BOTH pass (the
 * name has one inode; each claim is its own unique inode), so any residual race
 * becomes a NAMED refusal (LOCK-LOST-MIDWRITE), never a silent loss. */
const LOCK_STALE_MS = 30_000, LOCK_WAIT_MS = 2000;
/* R262c · the inode of MY currently-held lock (the CLI is single-threaded — one lock at a time) */
let ACTIVE_LOCK = null;
function lockOwnerPid(lockFile) {
  try {
    const pid = Number(readFileSync(lockFile, "utf8").trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null; // null = foreign garbage (not our format)
  } catch { return undefined; } // vanished between calls — retry
}
/* R262b · steals are serialized by a steal-mutex (O_EXCL on a fixed name, TTL'd):
 * inside it the lock name is still occupied by the dead inode, so no successor can
 * link — the check-then-act window collapses. An orphaned mutex (SIGKILL mid-steal)
 * is age-cleared and only ever delays steals, never plain writers. */
function stealIfDead(file, lockFile) {
  const stealMtx = `${file}.steal`;
  let mtx = null;
  try { mtx = openSync(stealMtx, "wx", 0o600); } catch (e) {
    if (e.code !== "EEXIST") throw e;
    try { if (Date.now() - statSync(stealMtx).mtimeMs > LOCK_STALE_MS) renameSync(stealMtx, `${stealMtx}.stale-${Date.now()}`); } catch { /* racing contender moved it */ }
    return; // another stealer is active — retry next loop
  }
  try {
    const owner = lockOwnerPid(lockFile);
    if (owner === undefined) return; // the lock vanished on its own
    let ownerIno = null;
    let dead = false;
    if (owner === null) {
      // foreign garbage: only the age law may clear it (never a fast steal)
      try { ownerIno = statSync(lockFile).ino; dead = Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS; } catch { return; }
    } else {
      // R259 · owner-liveness: a DEAD owner (ESRCH) is taken over instantly; the age
      // threshold stays as the backstop for a live-but-hung owner.
      try { ownerIno = statSync(lockFile).ino; } catch { return; }
      try { process.kill(owner, 0); } catch (pe) { dead = pe.code === "ESRCH"; }
      if (!dead) { try { dead = Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS; } catch { return; } }
    }
    if (dead) {
      // R262b · re-verify the inode immediately before the rename: the decision came
      // from an earlier read — if the name already points at another inode (a live
      // successor slipped in), the steal aborts.
      try {
        const inoNow = statSync(lockFile).ino;
        if (inoNow === ownerIno) renameSync(lockFile, `${lockFile}.stale-${Date.now()}`);
      } catch { /* the lock vanished on its own — nothing to steal */ }
    }
  } finally {
    try { closeSync(mtx); } catch { /* already closed */ }
    try { unlinkSync(stealMtx); } catch { /* already gone */ }
  }
}
function withLock(file, fn) {
  mkdirSync(path.dirname(file), { recursive: true }); // fresh clone: state/ may not exist yet (R258 lesson from the re-race)
  const lockFile = `${file}.lock`;
  const t0 = Date.now();
  for (;;) {
    let claimed = false;
    let ino = null;
    const claimFile = `${lockFile}.claim-${process.pid}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    try {
      const cfd = openSync(claimFile, "wx", 0o600); // born complete: the pid is inside BEFORE the lock name exists
      try { writeSync(cfd, `${process.pid} ${new Date().toISOString()}\n`); } finally { closeSync(cfd); }
      try {
        linkSync(claimFile, lockFile); claimed = true; // atomic: EEXIST = held; the lock is never born torn
        try { ino = statSync(claimFile).ino; } catch { /* cannot happen: we just linked it */ }
      } finally { try { unlinkSync(claimFile); } catch { /* already gone */ } }
    } catch (e) {
      try { unlinkSync(claimFile); } catch { /* already gone */ }
      if (e.code !== "EEXIST") throw e; // our claim debris; link-EEXIST = legitimate contention
    }
    if (claimed) {
      ACTIVE_LOCK = { file, ino }; // claim-inode == lock-inode (hardlink) — captured BEFORE the claim is unlinked
      try {
        return fn();
      } finally {
        ACTIVE_LOCK = null;
        try { if (lockOwnerPid(lockFile) === process.pid) unlinkSync(lockFile); } catch { /* already gone */ } // verify-before-unlink: never delete a stranger's lock
      }
    }
    if (Date.now() - t0 > LOCK_WAIT_MS) throw new Error(`LOCK-BUSY: ${path.basename(lockFile)} held by another writer`);
    stealIfDead(file, lockFile);
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); } catch { /* no blocking — continue */ }
  }
}

/* collision-proof id: Date.now() alone collided across two processes in the same
 * millisecond (measured in R258); R259: Math.random().toString(36).slice(2,6) can also
 * degenerate below 4 chars in the probability tail — randomUUID cuts the whole tail. */
const newId = (p) => `${p}-${Date.now().toString(36).toUpperCase()}${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;

/* R259 · validate-before-persist: deserialize refuses invalid state on READ, but nothing
 * stopped PERSISTING invalid state (measured live: task-add with a ghost dep / duplicate id
 * → poisoned store — every later command REFUSED until manual surgery). One choke point:
 * nothing lands on disk without passing the module's own validator. */
function persistValidated(file, doc, validate) {
  const v = validate(doc);
  if (!v.ok) throw new Error(`INVALID-STATE: ${v.errors.join(" · ")} — not saved (validate-before-persist, R259)`);
  atomicWrite(file, JSON.stringify(doc, null, 2));
}

/* קשירת-commit-לראיית-הדחיפה: ה-commit-חייב-להיות-קיים-ולהיות-ה-push-עצמו-או-אב-קדמון-שלו */
function commitPushBound(commit) {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { stdio: "ignore" });
    const pc = JSON.parse(readFileSync(PUSH_FILE, "utf8"));
    if (!pc.lastPushedSha) return false;
    if (pc.lastPushedSha === commit) return true;
    execFileSync("git", ["merge-base", "--is-ancestor", commit, pc.lastPushedSha], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/* ── ראיות-אמת מהעץ (החלק-היחיד-שנוגע-בקבצים-אמיתיים) ── */
function computeEvidence(commit) {
  const now = Date.now();
  const ev = { selftestGreen: false, selftestFresh: false, pushRecorded: false, pushShas: [] };
  try {
    const st = JSON.parse(readFileSync(SELFTEST_FILE, "utf8"));
    ev.selftestGreen = Number(st.fail) === 0 && Number(st.pass) > 0;
    ev.selftestFresh = Number.isFinite(Date.parse(st.at)) && now - Date.parse(st.at) < FRESH_MS;
    ev.selftestInfo = `${st.pass}/${st.pass + st.fail} @ ${st.at}`;
  } catch { /* honest-fail: נשאר false */ }
  try {
    const pc = JSON.parse(readFileSync(PUSH_FILE, "utf8"));
    if (pc.lastPushedSha && pc.pushedAt) {
      const fresh = now - Date.parse(pc.pushedAt) < FRESH_MS;
      const bound = fresh && commit ? commitPushBound(commit) : false;
      ev.pushRecorded = fresh && Boolean(pc.branch || pc.method);
      // ראיית-הדחיפה-נספרת-רק-אם-היא-קשורה-ל-commit-של-המשימה-עצמה — דחיפה-של-סוכן-אחר
      // על-תוכן-אחר לא סותרת-עבודה-שמעולם-לא-יצאה-מהעץ (החור-שהבקרה-השלילית-חשפה)
      ev.pushShas = fresh && commit && bound ? [pc.lastPushedSha] : [];
      ev.pushInfo = `${String(pc.lastPushedSha).slice(0, 7)} @ ${pc.pushedAt}${bound ? "" : " (לא-קשור-ל-commit-זה)"}`;
    }
  } catch { /* honest-fail */ }
  return ev;
}

function printHelp() {
  console.log("commands: tasks · task-add · task-set · progress · drill · decisions · decision-add · decision-answer · decision-settle · decision-reopen · decision-cancel (+ --json)");
}

try {
  for (const t of args.slice(1)) {
    if (t.startsWith("--") && !KNOWN_FLAGS.has(t)) {
      throw new Error(`UNKNOWN-FLAG: ${t} — argv is a closed contract; an unknown dash-flag is not content (known: ${[...KNOWN_FLAGS].join(" ")})`);
    }
  }
  switch (cmd) {
    case "tasks":
    case "progress": {
      const g = deserialize(loadJson(TASKS_FILE, { tasks: [] }));
      const p = progress(g);
      if (has("--json")) {
        console.log(JSON.stringify({ at: new Date().toISOString(), progress: p, tasks: g.tasks, ready: ready(g).map((t) => t.id) }, null, 2));
      } else {
        console.log(`tasks: ${g.tasks.length} · progress=${p} · ready=[${ready(g).map((t) => t.id).join(",")}]`);
        for (const t of g.tasks) {
          console.log(`  [${t.status.padEnd(9)}] ${t.id} (P${t.priority}${t.deps.length ? `, deps:${t.deps.join("+")}` : ""}) ${t.title}`);
        }
      }
      break;
    }
    case "task-add": {
      const title = args[1];
      // R259 · title guard: `task-add --id X title` silently saved the title "--id" (measured)
      if (!title || title.startsWith("--")) throw new Error('usage: task-add "<title>" [--priority N] [--deps a,b] — the title must come before flags');
      withLock(TASKS_FILE, () => {
        const g = deserialize(loadJson(TASKS_FILE, { tasks: [] }));
        const t = createTask({
          id: flagVal("--id") ?? newId("T"),
          title,
          priority: flagVal("--priority") ?? 0,
          deps: (flagVal("--deps") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
          assignee: flagVal("--assignee") ?? null,
        });
        g.tasks.push(t);
        persistValidated(TASKS_FILE, g, validateGraph);
        console.log(`added: ${t.id} (todo) ${t.title}`);
      });
      break;
    }
    case "task-set": {
      const [, id, to] = args;
      if (!id || !to) throw new Error("שימוש: task-set <id> <status>");
      if (!STATUSES.includes(to)) throw new Error(`סטטוס-לא-מוכר: ${to} (חוקי: ${STATUSES.join(",")})`);
      withLock(TASKS_FILE, () => {
        const g = deserialize(loadJson(TASKS_FILE, { tasks: [] }));
        let evidence;
        let commit;
        if (to === "done") {
          commit = flagVal("--commit");
          if (!commit) {
            throw new Error("DONE-GATE-REFUSED: done דורש --commit <sha> שנדחף-דרך-השער (done-only-via-verified-push — אין-עקיפה)");
          }
          evidence = computeEvidence(commit);
          console.log(`evidence: selftest=${evidence.selftestGreen && evidence.selftestFresh ? "GREEN-FRESH" : "UNFIT"} (${evidence.selftestInfo ?? "missing"}) · push=${evidence.pushRecorded ? "RECORDED" : "MISSING"} (${evidence.pushInfo ?? "missing"})`);
          if (!evidence.pushShas.length) {
            throw new Error(`DONE-GATE-REFUSED: ה-commit ${commit.slice(0, 7)} לא-מאומת-כדחוף-דרך-השער — דחפו-אותו-קודם (sovereign-push) ואז-נסו-שוב`);
          }
        }
        setStatus(g, id, to, { evidence, reason: flagVal("--reason"), commit });
        persistValidated(TASKS_FILE, g, validateGraph);
        console.log(`${id} → ${to}${to === "done" ? " ✓ (עבר-את-שער-הדחיפה-המאומתת)" : ""}`);
      });
      break;
    }
    case "drill": {
      const r = runDrill(Number(flagVal("--seed") ?? 252));
      if (has("--json")) {
        console.log(JSON.stringify({ ok: r.ok, steps: r.steps, validation: r.validation, tasks: r.g.tasks }, null, 2));
      } else {
        for (const s of r.steps) console.log(s);
        console.log(`DRILL ${r.ok ? "PASS" : "FAIL"} (seed=${r.g.seed})`);
      }
      if (!r.ok) process.exit(1);
      break;
    }
    case "decisions": {
      const dq = deserializeDQ(loadJson(DQ_FILE, { decisions: [] }));
      const open = listOpen(dq);
      if (has("--json")) {
        console.log(JSON.stringify({ at: new Date().toISOString(), openCount: open.length, decisions: dq.decisions }, null, 2));
      } else {
        console.log(`decisions: ${dq.decisions.length} total · ${open.length} open`);
        for (const d of dq.decisions) {
          console.log(`  [${d.status.padEnd(9)}] ${d.id} (${d.kind}) ${d.question}`);
          d.options.forEach((o, i) => console.log(`      ${i + 1}. ${o.label}${o.recommended ? " ← מומלץ" : ""}`));
          if (d.answer) console.log(`      תשובה: ${JSON.stringify(d.answer)}`);
        }
      }
      break;
    }
    case "decision-add": {
      const [, kind, question] = args;
      if (!kind || !question) throw new Error("שימוש: decision-add <question|permission|merge> \"<question>\" \"<opt1>\" \"<opt2>\"...");
      withLock(DQ_FILE, () => {
        const dq = deserializeDQ(loadJson(DQ_FILE, { decisions: [] }));
        const d = createDecision({ id: flagVal("--id") ?? newId("D"), kind, question, options: positional(args.slice(3)) });
        dq.decisions.push(d);
        persistValidated(DQ_FILE, dq, validateDQ);
        console.log(`decision-open: ${d.id} (${d.kind}) — ${d.options.length} אפשרויות, מומלץ: ${d.options[0]?.label ?? "—"}`);
      });
      break;
    }
    case "decision-answer": {
      const [, id, input] = args;
      withLock(DQ_FILE, () => {
        const dq = deserializeDQ(loadJson(DQ_FILE, { decisions: [] }));
        const d = answerDecision(dq, id, { by: flagVal("--by") ?? "operator", optionText: input, text: flagVal("--text") });
        persistValidated(DQ_FILE, dq, validateDQ);
        console.log(`answered: ${d.id} → ${d.answer.option ?? "(טקסט-חופשי)"}${d.answer.text ? ` · "${d.answer.text}"` : ""} — settle-רק-אחרי-האפקט-בפועל`);
      });
      break;
    }
    case "decision-settle": {
      withLock(DQ_FILE, () => {
        const dq = deserializeDQ(loadJson(DQ_FILE, { decisions: [] }));
        const d = settleDecision(dq, args[1]);
        persistValidated(DQ_FILE, dq, validateDQ);
        console.log(`settled: ${d.id}`);
      });
      break;
    }
    case "decision-reopen": {
      const reason = positional(args.slice(2)).join(" ");
      if (!reason) throw new Error('usage: decision-reopen <id> "<reason>" — the reason is required (it is preserved in history)');
      withLock(DQ_FILE, () => {
        const dq = deserializeDQ(loadJson(DQ_FILE, { decisions: [] }));
        const d = reopenDecision(dq, args[1], reason);
        persistValidated(DQ_FILE, dq, validateDQ);
        console.log(`reopened: ${d.id} — חוזר-ל-open עם-הסיבה-בהיסטוריה`);
      });
      break;
    }
    case "decision-cancel": {
      const reason = positional(args.slice(2)).join(" ");
      if (!reason) throw new Error('usage: decision-cancel <id> "<reason>" — the reason is required');
      withLock(DQ_FILE, () => {
        const dq = deserializeDQ(loadJson(DQ_FILE, { decisions: [] }));
        const d = cancelDecision(dq, args[1], reason);
        persistValidated(DQ_FILE, dq, validateDQ);
        console.log(`cancelled: ${d.id}`);
      });
      break;
    }
    default:
      printHelp();
      process.exit(cmd ? 2 : 0);
  }
} catch (e) {
  console.error(`REFUSED: ${e.message}`);
  process.exit(1);
}
