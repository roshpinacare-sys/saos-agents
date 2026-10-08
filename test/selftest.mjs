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
  /* R259 · mutation engine (Stryker-style): 30 mutants measured; 17 survived the existing net
   * → every vector below kills one measured survivor (kill-rate 43%→100%). A vector with no
   * mutation victim is decoration, not a test. */
  const FIXAVG = "---\nTask ID: A-1\nAgent: a\nTask: avg\n\nWork Log:\n- one\n\nStage Summary:\n- s\n---\nTask ID: A-2\nAgent: a\nTask: avg\n\nWork Log:\n- one\n\nStage Summary:\n- s\n---\nTask ID: A-3\nAgent: a\nTask: avg\n\nWork Log:\n- one\n- two\n\nStage Summary:\n- s\n";
  eq("worklog-intel: avgWorkBullets rounds to 2 decimals (kills M03)", wi.computeStats(wi.parseWorklog(FIXAVG)).avgWorkBullets, 1.33);
  const FIXTOP = "Task ID: P-1\nAgent: beta\nTask: t\n\nWork Log:\n- x\n\nStage Summary:\n- s\nTask ID: P-2\nAgent: alpha\nTask: t\n\nWork Log:\n- x\n\nStage Summary:\n- s\nTask ID: P-3\nAgent: alpha\nTask: t\n\nWork Log:\n- x\n\nStage Summary:\n- s\n";
  eq("worklog-intel: topAgents sorted by blocks desc (kills M04)", wi.computeStats(wi.parseWorklog(FIXTOP)).topAgents[0], { agent: "alpha", blocks: 2 });
  const FIXDUP = "Task ID: T-B\nAgent: a\nTask: t\n\nStage Summary:\n- s\nTask ID: T-A\nAgent: a\nTask: t\n\nStage Summary:\n- s\nTask ID: T-B\nAgent: b\nTask: t\n\nStage Summary:\n- s\nTask ID: T-A\nAgent: b\nTask: t\n\nStage Summary:\n- s\n";
  eq("worklog-intel: duplicates tie-break taskId asc (kills M05)", wi.computeStats(wi.parseWorklog(FIXDUP)).duplicates.map((d) => d.taskId), ["T-A", "T-B"]);
  eq("worklog-intel: floor boundary equal is NOT below (kills M06)", wi.detectAnomalies(wiStats, { minLines: wiStats.lineCount }).some((a) => a.kind === "below-floor"), false);
  eq("worklog-intel: floor boundary minus-1 IS below", wi.detectAnomalies(wiStats, { minLines: wiStats.lineCount + 1 }).some((a) => a.kind === "below-floor"), true);
  const FIXMS1 = "Task ID: S-1\nAgent: a\nTask: t\n\nWork Log:\n- x\n";
  eq("worklog-intel: exactly-1 missing summary still fires (kills M07)", wi.detectAnomalies(wi.computeStats(wi.parseWorklog(FIXMS1)), { text: FIXMS1 }).some((a) => a.kind === "missing-stage-summary"), true);
  eq("worklog-intel: startLine 1-based exact (kills M08)", parsed.blocks.map((b) => b.startLine), [4, 16, 24]);
  eq("worklog-intel: endLine boundary exact (kills M09)", [parsed.blocks[0].endLine, parsed.blocks.at(-1).endLine], [15, 27]);
  const FIXNOAG = "Task ID: N-1\nTask: t\n\nStage Summary:\n- s\n";
  eq("worklog-intel: agentless block keyed (kills M10)", wi.computeStats(wi.parseWorklog(FIXNOAG)).perAgent["(ללא-סוכן)"], 1);
    eq("worklog-intel: taskId trimmed (kills M13)", wi.parseWorklog("Task ID:   T-9  \nAgent: a\nTask: t\n").blocks[0].taskId, "T-9");
  /* R259 · fuzz caught: U+2028/U+2029 (ECMAScript line terminators — JSON.stringify emits them raw
   * since ES2019) glued before a header silently zeroed blocks — same silent-death family as
   * CRLF/BOM; now all normalized. */
  const FIXUSEP = "prose\u2028Task ID: U-1\nAgent: a\nTask: t\n\u2029Task ID: U-2\nAgent: b\nTask: t2\n";
  eq("worklog-intel: U+2028/U+2029 glued headers parse (fuzz class)", wi.parseWorklog(FIXUSEP).blocks.map((b) => b.taskId), ["U-1", "U-2"]);
  eq("worklog-intel: U+2028/U+2029 lineCount measured", wi.parseWorklog(FIXUSEP).lineCount, 9);
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
  /* R259 · mutation engine — the kills that remained in taskgraph/decisionqueue: */
  const gr = G();
  tg.setStatus(gr, "A", "doing"); tg.setStatus(gr, "A", "review");
  eq("taskgraph: progress weights review=0.75 (kills M14)", tg.progress(gr), 0.25);
  eq("taskgraph: createTask dedupes deps (kills M17)", tg.createTask({ id: "DD", title: "d", deps: ["A", "A", "A"] }).deps, ["A"]);
  eq("taskgraph: validate catches duplicate id (kills M18)", tg.validateGraph({ tasks: [tg.createTask({ id: "D", title: "1" }), tg.createTask({ id: "D", title: "2" })] }).errors.some((e) => e.includes("כפילות-id")), true);
  caught = null;
  try { tg.createTask({ id: "SD", title: "s", deps: ["SD"] }); } catch (e) { caught = e.code; }
  eq("taskgraph: createTask refuses self-dep (kills M20)", caught, "SELF-DEP");
  eq("taskgraph: validate catches self-dep (kills M20b)", tg.validateGraph({ tasks: [{ id: "SD", title: "s", status: "todo", deps: ["SD"] }] }).errors.some((e) => e.includes("תלות-עצמית")), true);
  const gsh = G();
  tg.setStatus(gsh, "A", "doing"); tg.setStatus(gsh, "A", "review");
  gsh.tasks[0].commit = sha;
  caught = null;
  try { tg.setStatus(gsh, "A", "done", { evidence: { selftestGreen: true, selftestFresh: true, pushRecorded: true, pushShas: ["sha-OTHER"] }, commit: sha }); } catch (e) { caught = e.code; }
  eq("taskgraph: done-gate binds commit to push evidence (kills M21)", caught, "DONE-GATE-REFUSED");
  eq("taskgraph: mulberry32 coerces seed to uint32 (kills M22)", tg.mulberry32(2 ** 32)(), tg.mulberry32(0)());
  eq("decisionqueue: match caseless ascii (kills M23)", dq.matchOption([{ label: "APPROVE" }, { label: "DENY" }], "approve"), 0);
  caught = null;
  try { dq.matchOption([{ label: "A" }, { label: "B" }], "0"); } catch (e) { caught = e.code; }
  eq("decisionqueue: numeric 0 refused (kills M25)", caught, "NO-MATCH");
  /* ── R260 · giant-round probes became law (each one measured live on the artifact) ──
   * P1 — the silent pretense: a bare `decision-answer <id>` persisted answer={by,at} and
   * closed the decision without saying anything (measured rc=0). An answer must SAY
   * something: an option or non-empty text. */
  caught = null;
  try { dq.answerDecision(mk(), "D1", {}); } catch (e) { caught = e.code; }
  eq("decisionqueue: bare answer (no option/text) refused — no silent pretense (R260 P1)", caught, "INVALID-DECISION");
  caught = null;
  try { dq.answerDecision(mk(), "D1", { text: "" }); } catch (e) { caught = e.code; }
  eq("decisionqueue: empty-string text is still no content (R260 P1)", caught, "INVALID-DECISION");
  /* P4 — machine-channel ordering must not depend on ICU: measured localeCompare("a","B") = -1
   * while code-unit says B<a; an ICU-less node build (or another ICU version) reorders again.
   * Operator queues are a machine contract — code-unit, always. */
  const gIcu = { tasks: [
    tg.createTask({ id: "T-a", title: "a", createdAt: "2026-01-01T00:00:00Z" }),
    tg.createTask({ id: "T-B", title: "b", createdAt: "2026-01-01T00:00:00Z" }),
  ] };
  eq("taskgraph: ready tie-break is code-unit, ICU-free (B<a, not ICU's a<B) (R260 P4)", tg.ready(gIcu).map((t) => t.id), ["T-B", "T-a"]);
  eq("decisionqueue: listOpen tie-break code-unit (R260 P4)", dq.listOpen({ decisions: [
    dq.createDecision({ id: "b-1", kind: "question", question: "x", options: ["a"], createdAt: "2026-01-01T00:00:00Z" }),
    dq.createDecision({ id: "B-2", kind: "question", question: "y", options: ["a"], createdAt: "2026-01-01T00:00:00Z" }),
  ] }).map((d) => d.id), ["B-2", "b-1"]);
  /* P9 — structural junk is refused BY NAME (measured: a missing priority rendered as
   * "Pundefined"; string deps iterated char-by-char; a missing options array crashed the
   * rendering path with an engine-dependent TypeError instead of a named refusal). */
  eq("taskgraph: validateGraph refuses deps-as-string (R260 P9)", tg.validateGraph({ tasks: [{ id: "S", title: "s", status: "todo", deps: "AB", priority: 0 }] }).errors.some((e) => e.includes("deps-לא-מערך")), true);
  eq("taskgraph: validateGraph refuses junk priority (R260 P9)", tg.validateGraph({ tasks: [{ id: "S", title: "s", status: "todo", deps: [], priority: "high" }] }).errors.some((e) => e.includes("עדיפות-פגומה")), true);
  eq("taskgraph: validateGraph refuses empty title (R260 P9)", tg.validateGraph({ tasks: [{ id: "S", title: "", status: "todo", deps: [], priority: 0 }] }).errors.some((e) => e.includes("כותרת-פגומה")), true);
  eq("decisionqueue: validateDQ refuses missing options array (R260 P9)", dq.validateDQ({ decisions: [{ id: "X", kind: "question", question: "q", status: "open" }] }).errors.some((e) => e.includes("אפשרויות-פגומות")), true);
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
