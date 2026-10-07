/* R252 · WORKLOG-INTEL — טלמטריה על-המצע-שלנו-עצמו (זיקוק-ראשון-מ-agentcraft).
 *
 * לקח-המקור (blendi-remade/agentcraft, HEAD 35da4f5): הערך-הוא-לא-בתצוגה אלא-במנוע-שמודד-את-עצמו
 * (Foreman: state.json-אטומי · snapshot/upsert · TaskGraph · DecisionQueue · טלמטריה-per-tool).
 * התרגום-שלנו: ה-worklog הוא ה-ledger האפנד-אונלי שלנו — כלי-שמפרק-אותו-לבלוקים-מדודים,
 * מזהה-כפילויות, חוסרי-סיכום, ובעיקר **התכווצות** (הפרת-append-only — משפחת-ה-regressions
 * c60ebae/95e90d2 שנתפסו-פעמיים-בפועל) — הוא-הערוץ-המכונתי-הראשון-של-הקונסול-החי.
 *
 * מודול-טהור: אין-fs, אין-רשת — ה-selftest מייבא-אותו-אופליין. ה-CLI: scripts/worklog-analytics.mjs
 */

/* ── פרסור סובלני: בלוק = "Task ID:" בראש-שורה (עם-או-בלי-מפריד "---" לפני —
 * בלוקי-R245-d-ההיסטוריים-דבוקים והם-חוקיים). לא-שורות-תבליט לא-נספרות. ── */
export function parseWorklog(text) {
  // normalize BOM + CRLF/CR → LF BEFORE splitting: JS `$` never matches before \r and `.` never
  // consumes it, so a Windows (autocrlf) file yielded ZERO blocks; a UTF-8-BOM file (Notepad)
  // also zeroed its first glued block. Measured, not assumed (R257+R258).
  const lines = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let cur = null;
  let phase = "header"; // header | work | summary

  const close = (idx) => {
    if (cur) {
      cur.endLine = idx;
      blocks.push(cur);
      cur = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const mTask = line.match(/^Task ID:\s*(.*)$/);
    if (mTask) {
      close(i);
      cur = {
        taskId: mTask[1].trim(),
        agent: null,
        task: "",
        workBullets: [],
        summaryBullets: [],
        startLine: i + 1,
        endLine: null,
      };
      phase = "header";
      continue;
    }
    if (!cur) continue;
    if (phase === "header") {
      const mA = line.match(/^Agent:\s*(.*)$/);
      if (mA) {
        cur.agent = mA[1].trim() || null;
        continue;
      }
      const mT = line.match(/^Task:\s*(.*)$/);
      if (mT) {
        cur.task = mT[1].trim();
        continue;
      }
      if (/^Work Log:\s*$/.test(line)) {
        phase = "work";
        continue;
      }
      if (/^Stage Summary:\s*$/.test(line)) {
        phase = "summary";
        continue;
      }
    } else if (phase === "work") {
      if (/^Stage Summary:\s*$/.test(line)) {
        phase = "summary";
        continue;
      }
      const mB = line.match(/^[-*]\s+(.*)$/);
      if (mB) cur.workBullets.push(mB[1].trim());
      continue;
    } else if (phase === "summary") {
      const mB = line.match(/^[-*]\s+(.*)$/);
      if (mB) cur.summaryBullets.push(mB[1].trim());
      continue;
    }
  }
  close(lines.length);
  return { blocks, lineCount: lines.length };
}

/* ── מדדים: כמות, סוכנים, כפילויות (union-חוקי-אבל-חייב-להיות-גלוי), חוסרי-סיכום ── */
export function computeStats(parsed) {
  const blocks = parsed?.blocks ?? [];
  const perAgent = {};
  const perTask = {};
  for (const b of blocks) {
    const a = b.agent ?? "(ללא-סוכן)";
    perAgent[a] = (perAgent[a] ?? 0) + 1;
    const t = b.taskId || "(ללא-מזהה)";
    perTask[t] = (perTask[t] ?? 0) + 1;
  }
  const duplicates = Object.entries(perTask)
    .filter(([, n]) => n > 1)
    .map(([taskId, count]) => ({ taskId, count }))
    .sort((x, y) => y.count - x.count || x.taskId.localeCompare(y.taskId));
  const workBullets = blocks.map((b) => b.workBullets.length);
  return {
    totalBlocks: blocks.length,
    lineCount: parsed?.lineCount ?? 0,
    perAgent,
    perTask,
    duplicates,
    blocksMissingSummary: blocks.filter((b) => b.summaryBullets.length === 0).length,
    avgWorkBullets: blocks.length
      ? Math.round((workBullets.reduce((s, n) => s + n, 0) / blocks.length) * 100) / 100
      : 0,
    topAgents: Object.entries(perAgent)
      .map(([agent, blocksCount]) => ({ agent, blocks: blocksCount }))
      .sort((x, y) => y.blocks - x.blocks),
  };
}

/* ── אנומליות: התכווצות = הפרת-append-only (האויב-הנמדד). fail-honest, לא-שקט. ── */
export function detectAnomalies(stats, opts = {}) {
  const out = [];
  const prev = opts.previousLineCount;
  if (Number.isFinite(prev) && prev !== null && stats.lineCount < prev) {
    out.push({
      kind: "append-only-shrink",
      detail: `worklog התכווץ: ${prev}→${stats.lineCount} שורות — דרוש-שחזור-מההיסטוריה (חוק-ה-lineage)`,
    });
  }
  const minLines = opts.minLines;
  if (Number.isFinite(minLines) && stats.lineCount < minLines) {
    out.push({ kind: "below-floor", detail: `${stats.lineCount}<${minLines} שורות — מתחת-לרצפה-שנקבעה` });
  }
  for (const d of stats.duplicates) {
    out.push({ kind: "duplicate-task-id", detail: `Task ID ${d.taskId} מופיע ×${d.count} — union-חוקי-אך-ראוי-לביקורת` });
  }
  if (stats.blocksMissingSummary > 0) {
    out.push({ kind: "missing-stage-summary", detail: `${stats.blocksMissingSummary} בלוקים בלי Stage Summary` });
  }
  if (typeof opts.text === "string" && opts.text.length > 0 && !opts.text.endsWith("\n")) {
    out.push({ kind: "no-trailing-newline", detail: "הקובץ-לא-נגמר-בשורה-חדשה" });
  }
  if (stats.totalBlocks === 0) {
    out.push({ kind: "no-blocks", detail: "לא-נמצאו-בלוקים — או-קובץ-ריק-או-פורמט-שבור" });
  }
  return out;
}

/* ── selftest עצמאי (ל-CLI): פיקסטורות-סינתטיות-בלבד ── */
export function runAnalyticsSelftest() {
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
  let pass = 0;
  let fail = 0;
  const eq = (name, actual, expected) => {
    const good = JSON.stringify(actual) === JSON.stringify(expected);
    if (good) pass++;
    else fail++;
    console.log(`${good ? "PASS" : "FAIL"} ${name}${good ? "" : ` — expected=${JSON.stringify(expected)} got=${JSON.stringify(actual)}`}`);
  };
  const parsed = parseWorklog(FIX);
  eq("blocks count", parsed.blocks.length, 3);
  eq("first taskId", parsed.blocks[0].taskId, "T-1");
  eq("glued block parsed (no --- sep)", parsed.blocks[1].agent, "beta");
  eq("bullets skip prose", parsed.blocks[0].workBullets.length, 2);
  eq("summary bullets", parsed.blocks[0].summaryBullets.length, 1);
  eq("hebrew intact", parsed.blocks[0].task, "ראשון");
  const st = computeStats(parsed);
  eq("perAgent alpha", st.perAgent["alpha"], 2);
  eq("perAgent beta", st.perAgent["beta"], 1);
  eq("duplicate flagged", (st.duplicates[0] ?? {}).count, 2);
  eq("missing summary count", st.blocksMissingSummary, 2);
  eq("shrink caught", detectAnomalies(st, { text: FIX, previousLineCount: 999 }).some((a) => a.kind === "append-only-shrink"), true);
  eq("clean fixture no anomalies", detectAnomalies(computeStats(parseWorklog(FIX2)), { text: FIX2, previousLineCount: null }).length, 0);
  console.log(`\nANALYTICS-SELFTEST ${pass}/${pass + fail} ${fail === 0 ? "PASS" : "FAIL"}`);
  return { pass, fail };
}
