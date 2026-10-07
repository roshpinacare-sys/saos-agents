/**
 * selftest.mjs — deterministic offline vectors for the saos-agents open core.
 * Zero network, zero clock, zero randomness. RUN: bun test/selftest.mjs
 *
 * A smaller test that still passes is a lie, not a success: lineage floors
 * below fail loud if any vector block is ever swept.
 */

let pass = 0, fail = 0;
const eq = (name, a, b) => {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja === jb) { pass++; }
  else { fail++; console.error(`FAIL ${name}\n  got: ${ja}\n  want: ${jb}`); }
};
const ok = (name, cond) => (cond ? pass++ : (fail++, console.error(`FAIL ${name}`)));

/* R252 · WORKLOG-INTEL: טלמטריה-על-המצע-שלנו — ההשתלה-הראשונה-מזיקוק-agentcraft.
 * ה-worklog הוא-ה-ledger-האפנד-אונלי; מפרק-מדוד-שלו (בלוקים/סוכנים/כפילויות/
 * התכווצות) הוא-הערוץ-המכונתי-הראשון-של-הקונסול-החי. משפחת-ה-regressions
 * c60ebae/95e90d2 (דריסת-worklog, השתקת-selftest) היא-האויב-הנמדד:
 * detectAnomalies תופס-התכווצות BY CONSTRUCTION. מודול-טהור — אין-fs/רשת. */
{
  const wi = await import("../src/worklog-intel.mjs");
  const FIX = [
    "# WORKLOG",
    "",
    "---",
    "Task ID: T-1",
    "Agent: alpha",
    "Task: ראשון",
    "",
    "Work Log:",
    "- אחד",
    "- שניים",
    "פרוזה שאינה תבליט",
    "",
    "Stage Summary:",
    "- סיכום-א",
    "",
    "Task ID: T-1",
    "Agent: beta",
    "Task: כפול",
    "",
    "Work Log:",
    "- שלישי",
    "",
    "---",
    "Task ID: T-2",
    "Agent: alpha",
    "Task: שני",
    "",
  ].join("\n");
  const FIX2 = "---\nTask ID: OK-1\nAgent: alpha\nTask: נקי\n\nWork Log:\n- א\n\nStage Summary:\n- ב\n";
  const parsed = wi.parseWorklog(FIX);
  eq("worklog-intel: block count", parsed.blocks.length, 3);
  eq("worklog-intel: first taskId", parsed.blocks[0].taskId, "T-1");
  eq("worklog-intel: glued block parsed (no --- sep)", parsed.blocks[1].agent, "beta");
  eq("worklog-intel: bullets skip prose", parsed.blocks[0].workBullets.length, 2);
  eq("worklog-intel: summary bullets", parsed.blocks[0].summaryBullets.length, 1);
  eq("worklog-intel: hebrew intact", parsed.blocks[0].task, "ראשון");
  eq("worklog-intel: lineCount measured", parsed.lineCount, 27);
  const wiStats = wi.computeStats(parsed);
  eq("worklog-intel: perAgent alpha", wiStats.perAgent["alpha"], 2);
  eq("worklog-intel: perAgent beta", wiStats.perAgent["beta"], 1);
  eq("worklog-intel: duplicate flagged", (wiStats.duplicates[0] ?? {}).count, 2);
  eq("worklog-intel: missing summary count", wiStats.blocksMissingSummary, 2);
  eq("worklog-intel: topAgents sorted", wiStats.topAgents[0], { agent: "alpha", blocks: 2 });
  eq("worklog-intel: shrink violation caught", wi.detectAnomalies(wiStats, { text: FIX, previousLineCount: 999 }).some((a) => a.kind === "append-only-shrink"), true);
  eq("worklog-intel: floor violation caught", wi.detectAnomalies(wiStats, { text: FIX, minLines: 500 }).some((a) => a.kind === "below-floor"), true);
  eq("worklog-intel: trailing-newline caught", wi.detectAnomalies(wiStats, { text: FIX + "x" }).some((a) => a.kind === "no-trailing-newline"), true);
  eq("worklog-intel: empty worklog flagged", wi.detectAnomalies(wi.computeStats(wi.parseWorklog("")), { text: "" }).some((a) => a.kind === "no-blocks"), true);
  eq("worklog-intel: clean fixture zero anomalies", wi.detectAnomalies(wi.computeStats(wi.parseWorklog(FIX2)), { text: FIX2, previousLineCount: null }).length, 0);
  /* CRLF/CR normalization: Windows (autocrlf) files must MEASURE, not just alarm —
   * in JS `$` never matches before \r and `.` never consumes it, so `^Task ID:` never opened. */
  const FIXCRLF = "---\r\nTask ID: W-1\r\nAgent: alpha\r\nTask: win\r\n\r\nWork Log:\r\n- one\r\n\r\nStage Summary:\r\n- s\r\n";
  const pc = wi.parseWorklog(FIXCRLF);
  eq("worklog-intel: CRLF parses (windows autocrlf)", [pc.blocks.length, pc.blocks[0].taskId, pc.blocks[0].workBullets.length], [1, "W-1", 1]);
  eq("worklog-intel: CRLF clean file zero anomalies", wi.detectAnomalies(wi.computeStats(pc), { text: FIXCRLF, previousLineCount: null }).length, 0);
  eq("worklog-intel: CRLF lineCount measured", pc.lineCount, 11);
  eq("worklog-intel: bare CR parses (classic mac)", wi.parseWorklog("Task ID: M-1\rAgent: beta\rTask: mac\r\rWork Log:\r- x\r\rStage Summary:\r- y\r").blocks[0].taskId, "M-1");
  /* BOM: a UTF-8-BOM file (Notepad) lost its first glued block — `^Task ID:` never opened behind \uFEFF. */
  const FIXBOM = "\uFEFFTask ID: B-1\nAgent: alpha\nTask: bom\n\nWork Log:\n- x\n\nStage Summary:\n- y\n";
  eq("worklog-intel: BOM stripped, first glued block opens", wi.parseWorklog(FIXBOM).blocks[0].taskId, "B-1");
  eq("worklog-intel: BOM file measures clean", wi.detectAnomalies(wi.computeStats(wi.parseWorklog(FIXBOM)), { text: FIXBOM, previousLineCount: null }).length, 0);
  const cliSrc = await (async () => {
    try {
      const fsx = await import("node:fs");
      return fsx.readFileSync(new URL("../cli/worklog-analytics.mjs", import.meta.url), "utf8");
    } catch {
      return "";
    }
  })();
  ok("worklog-intel: CLI module exists (cli/worklog-analytics.mjs)", cliSrc.includes("--selftest") && cliSrc.includes("detectAnomalies"));
}
/* R253 · TASKGRAPH + DECISIONQUEUE: גל-2 של זיקוק-agentcraft — תיאום-סוכנים-מבני.
 * done-only-via-verified-push = התרופה-המבנית ל-custodian-sweeps (95e90d2); DecisionQueue =
 * פעולות-מפעיל יוצאות-כהחלטות-גלויות ולא-עוצרות-בשקט (הפטול של PAT-E403×3).
 * מודולים-טהורים — אין-fs/רשת; הראיות-האמיתיות מחושבות-רק-ב-CLI. */
{
  const tg = await import("../src/taskgraph.mjs");
  const dq = await import("../src/decisionqueue.mjs");

  const G = () => ({
    tasks: [
      tg.createTask({ id: "A", title: "ראשונה", priority: 5, createdAt: "2026-01-01T00:00:00Z" }),
      tg.createTask({ id: "B", title: "תלויה", priority: 3, deps: ["A"], createdAt: "2026-01-01T00:01:00Z" }),
      tg.createTask({ id: "C", title: "מקבילה", priority: 1, createdAt: "2026-01-01T00:02:00Z" }),
    ],
  });

  eq("taskgraph: legal transition", tg.canTransition("todo", "doing"), true);
  eq("taskgraph: terminal blocks all", tg.canTransition("done", "doing"), false);
  eq("taskgraph: review can done (gated)", tg.canTransition("review", "done"), true);
  eq("taskgraph: createTask defaults", [G().tasks[0].status, G().tasks[0].statusHistory.length], ["todo", 1]);
  eq("taskgraph: deps gate holds B", tg.ready(G()).map((t) => t.id), ["A", "C"]);
  eq("taskgraph: ready priority order", tg.ready(G()).map((t) => t.id)[0], "A");
  const g1 = G();
  tg.setStatus(g1, "A", "doing"); tg.setStatus(g1, "A", "review");
  eq("taskgraph: history trail", g1.tasks[0].statusHistory.map((h) => h.to), ["todo", "doing", "review"]);
  let caught = null;
  try { tg.setStatus(g1, "A", "done", { evidence: null }); } catch (e) { caught = e.code; }
  eq("taskgraph: done-gate refuses null evidence", caught, "DONE-GATE-REFUSED");
  caught = null;
  try { tg.setStatus(g1, "A", "done", { evidence: { selftestGreen: true, selftestFresh: false, pushRecorded: true, pushShas: [] } }); } catch (e) { caught = e.code; }
  eq("taskgraph: done-gate refuses stale selftest", caught, "DONE-GATE-REFUSED");
  const g2 = G();
  tg.setStatus(g2, "A", "doing"); tg.setStatus(g2, "A", "review");
  const sha = "sha-abc123";
  tg.setStatus(g2, "A", "done", { evidence: { selftestGreen: true, selftestFresh: true, pushRecorded: true, pushShas: [sha] }, commit: sha });
  eq("taskgraph: done passes via gate", g2.tasks[0].status, "done");
  eq("taskgraph: deps released after done", tg.ready(g2).map((t) => t.id), ["B", "C"]);
  const g3 = G();
  tg.setStatus(g3, "A", "doing");
  eq("taskgraph: progress mixed", tg.progress(g3), 0.133);
  const cyc = { tasks: [tg.createTask({ id: "X", title: "x", deps: ["Y"] }), tg.createTask({ id: "Y", title: "y", deps: ["X"] })] };
  eq("taskgraph: cycle detected", tg.validateGraph(cyc).ok, false);
  eq("taskgraph: unknown status caught", tg.validateGraph({ tasks: [{ id: "Z", status: "zap", deps: [] }] }).ok, false);
  eq("taskgraph: serialize roundtrip", tg.serialize(tg.deserialize(tg.serialize(g2))), tg.serialize(g2));
  const d1 = tg.runDrill(7);
  const d2 = tg.runDrill(7);
  eq("taskgraph: drill deterministic", [d1.ok, d1.steps.length === d2.steps.length], [true, true]);
  eq("taskgraph: drill exercises the gate", d1.steps.some((s) => s.includes("DONE-GATE-REFUSED")), true);

  const mk = () => ({ decisions: [dq.createDecision({ id: "D1", kind: "question", question: "לאיזה-כיוון?", options: ["כן", "לא"], createdAt: "2026-01-01T00:00:00Z" })] });
  const q1 = mk();
  eq("decisionqueue: recommended-first", q1.decisions[0].options.map((o) => o.recommended), [true, false]);
  eq("decisionqueue: match by index", dq.matchOption(q1.decisions[0].options, "2"), 1);
  eq("decisionqueue: match exact caseless", dq.matchOption(q1.decisions[0].options, "  לא "), 1);
  eq("decisionqueue: match unique prefix", dq.matchOption([{ label: "public" }, { label: "private" }], "pub"), 0);
  caught = null;
  try { dq.matchOption([{ label: "כן-עכשיו" }, { label: "כן-מחר" }], "כן"); } catch (e) { caught = e.code; }
  eq("decisionqueue: ambiguous prefix caught", caught, "AMBIGUOUS");
  caught = null;
  try { dq.matchOption(q1.decisions[0].options, "אולי"); } catch (e) { caught = e.code; }
  eq("decisionqueue: no-match caught", caught, "NO-MATCH");
  const q2 = mk();
  dq.answerDecision(q2, "D1", { by: "operator", optionIndex: 1 });
  eq("decisionqueue: answer recorded", [q2.decisions[0].status, q2.decisions[0].answer.option], ["answered", "לא"]);
  caught = null;
  try { dq.answerDecision(q2, "D1", { optionIndex: 1 }); } catch (e) { caught = e.code; }
  eq("decisionqueue: double-answer refused", caught, "NOT-OPEN");
  caught = null;
  try { dq.settleDecision(q2, "NOPE"); } catch (e) { caught = e.code; }
  eq("decisionqueue: settle unknown caught", caught, "NO-DECISION");
  const q3 = mk();
  caught = null;
  try { dq.settleDecision(q3, "D1"); } catch (e) { caught = e.code; }
  eq("decisionqueue: settle before answer refused", caught, "NOT-ANSWERED");
  dq.answerDecision(q3, "D1", { optionIndex: 1 });
  dq.settleDecision(q3, "D1");
  eq("decisionqueue: settle after answer", q3.decisions[0].status, "settled");
  dq.reopenDecision(q3, "D1", "Merge refused: סיבה-מתועדת");
  eq("decisionqueue: reopen restores open", [q3.decisions[0].status, q3.decisions[0].answer], ["open", null]);
  eq("decisionqueue: reopen reason in history", q3.decisions[0].statusHistory.at(-1).reason, "Merge refused: סיבה-מתועדת");
  const q4 = mk();
  dq.cancelDecision(q4, "D1", "מיותרת");
  eq("decisionqueue: cancel", q4.decisions[0].status, "cancelled");
  caught = null;
  try { dq.reopenDecision(q4, "D1", "x"); } catch (e) { caught = e.code; }
  eq("decisionqueue: no reopen after cancel", caught, "CANCELLED");
  const q5 = {
    decisions: [
      dq.createDecision({ id: "LATE", kind: "question", question: "שנייה", options: ["a"], createdAt: "2026-01-02T00:00:00Z" }),
      dq.createDecision({ id: "EARLY", kind: "merge", question: "ראשונה", options: ["b"], createdAt: "2026-01-01T00:00:00Z" }),
    ],
  };
  eq("decisionqueue: listOpen oldest-first", dq.listOpen(q5).map((d) => d.id), ["EARLY", "LATE"]);
  eq("decisionqueue: validate catches ghost answer", dq.validateDQ({ decisions: [{ ...dq.createDecision({ id: "G", kind: "question", question: "x", options: ["a"] }), status: "answered", answer: null }] }).ok, false);
  eq("decisionqueue: dq roundtrip", dq.serializeDQ(dq.deserializeDQ(dq.serializeDQ(q2))), dq.serializeDQ(q2));
}

/* lineage: the measured enemy is silent shrinkage of this file itself —
 * BY CONSTRUCTION these floors fail loud if any block is swept. */
{
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL(import.meta.url), "utf8");
  ok("lineage: size floor (>=180 lines)", src.split("\n").length >= 180);
  const lineageCalls = (src.match(/^[ \t]*(?:eq|ok)\(/gm) ?? []).length;
  ok("lineage: vector-call floor (>=53)", lineageCalls >= 53);
}

console.log(`\nSELFTEST ${pass}/${pass + fail} ${fail === 0 ? "PASS" : "FAIL"}`);
/* last-run marker: written ONLY on a full run, never by a partial import. */
try {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const STATE = path.join(HERE, "..", "state");
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(path.join(STATE, "selftest-last-run.json"), JSON.stringify({ pass, fail, at: new Date().toISOString(), vectors: pass + fail }, null, 2));
} catch { /* state dir may be read-only in CI — the verdict above stands */ }
process.exit(fail === 0 ? 0 : 1);
