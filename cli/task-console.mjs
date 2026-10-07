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
  createTask, setStatus, ready, progress, validateGraph, deserialize, serialize,
  runDrill, STATUSES,
} from "../src/taskgraph.mjs";
import {
  createDecision, answerDecision, settleDecision, reopenDecision, cancelDecision,
  listOpen, deserializeDQ, serializeDQ,
} from "../src/decisionqueue.mjs";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
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
const has = (f) => args.includes(f);
const flagVal = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const FRESH_MS = 24 * 60 * 60 * 1000;

function atomicWrite(file, content) {
  mkdirSync(path.dirname(file), { recursive: true }); // fresh clone: state/ does not exist yet
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}
function loadJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    // הסגר-בסגנון-המקור: לא crash-loop — קובץ-קורום מועבר-לצד-ומתחיל-נקי
    const quarantine = `${file}.corrupt-${Date.now()}`;
    renameSync(file, quarantine);
    console.error(`[task-console] קובץ-קורום-הועבר-להסגר: ${path.basename(quarantine)}`);
    return fallback;
  }
}

/* פוזיציונליים-בלבד: מדלג-על --flag וגם-על-ערכו (הצולע-שגרם ל-D-VIS-בעלת-3-אפשרויות) */
function positional(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].startsWith("--")) { i++; continue; }
    out.push(list[i]);
  }
  return out;
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
      if (!title) throw new Error("שימוש: task-add \"<title>\" [--priority N] [--deps a,b]");
      const g = deserialize(loadJson(TASKS_FILE, { tasks: [] }));
      const t = createTask({
        id: flagVal("--id") ?? `T-${Date.now().toString(36).toUpperCase()}`,
        title,
        priority: flagVal("--priority") ?? 0,
        deps: (flagVal("--deps") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        assignee: flagVal("--assignee") ?? null,
      });
      g.tasks.push(t);
      atomicWrite(TASKS_FILE, serialize(g));
      console.log(`added: ${t.id} (todo) ${t.title}`);
      break;
    }
    case "task-set": {
      const [, id, to] = args;
      if (!id || !to) throw new Error("שימוש: task-set <id> <status>");
      if (!STATUSES.includes(to)) throw new Error(`סטטוס-לא-מוכר: ${to} (חוקי: ${STATUSES.join(",")})`);
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
      atomicWrite(TASKS_FILE, serialize(g));
      console.log(`${id} → ${to}${to === "done" ? " ✓ (עבר-את-שער-הדחיפה-המאומתת)" : ""}`);
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
      const dq = existsSync(DQ_FILE) ? deserializeDQ(readFileSync(DQ_FILE, "utf8")) : { decisions: [] };
      const d = createDecision({ id: flagVal("--id") ?? `D-${Date.now().toString(36).toUpperCase()}`, kind, question, options: positional(args.slice(3)) });
      dq.decisions.push(d);
      atomicWrite(DQ_FILE, serializeDQ(dq));
      console.log(`decision-open: ${d.id} (${d.kind}) — ${d.options.length} אפשרויות, מומלץ: ${d.options[0]?.label ?? "—"}`);
      break;
    }
    case "decision-answer": {
      const [, id, input] = args;
      const dq = deserializeDQ(loadJson(DQ_FILE, { decisions: [] }));
      const d = answerDecision(dq, id, { by: flagVal("--by") ?? "operator", optionText: input, text: flagVal("--text") });
      atomicWrite(DQ_FILE, serializeDQ(dq));
      console.log(`answered: ${d.id} → ${d.answer.option ?? "(טקסט-חופשי)"}${d.answer.text ? ` · "${d.answer.text}"` : ""} — settle-רק-אחרי-האפקט-בפועל`);
      break;
    }
    case "decision-settle": {
      const dq = deserializeDQ(loadJson(DQ_FILE, { decisions: [] }));
      const d = settleDecision(dq, args[1]);
      atomicWrite(DQ_FILE, serializeDQ(dq));
      console.log(`settled: ${d.id}`);
      break;
    }
    case "decision-reopen": {
      const dq = deserializeDQ(loadJson(DQ_FILE, { decisions: [] }));
      const d = reopenDecision(dq, args[1], positional(args.slice(2)).join(" "));
      atomicWrite(DQ_FILE, serializeDQ(dq));
      console.log(`reopened: ${d.id} — חוזר-ל-open עם-הסיבה-בהיסטוריה`);
      break;
    }
    case "decision-cancel": {
      const dq = deserializeDQ(loadJson(DQ_FILE, { decisions: [] }));
      const d = cancelDecision(dq, args[1], positional(args.slice(2)).join(" "));
      atomicWrite(DQ_FILE, serializeDQ(dq));
      console.log(`cancelled: ${d.id}`);
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
