#!/usr/bin/env bun
/* R252 · worklog-analytics — CLI-רזה-מעל worklog-intel.mjs (זיקוק-מ-agentcraft:
 * טלמטריה-חיה-על-ה-ledger שלנו). הערוץ-המכונתי-הראשון-של-הקונסול: מפרק את
 * worklog.md לבלוקים, מודד-סוכנים/משימות, ותופס-כנה-הפרות-append-only.
 *
 * RUN (bun or node ≥ 18):
 *   bun cli/worklog-analytics.mjs                       # סיכום-אנושי על worklog.md
 *   bun cli/worklog-analytics.mjs --json                # JSON לקונסול/מכונה
 *   bun cli/worklog-analytics.mjs --file other.md --min-lines 100
 *   bun cli/worklog-analytics.mjs --selftest            # וקטורים-פנימיים
 *
 * אין-כתיבה-לשום-קובץ-כברירת-מחדל — קריאה-בלבד, כנות-מלאה.
 */
import { parseWorklog, computeStats, detectAnomalies, runAnalyticsSelftest } from "../src/worklog-intel.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

if (has("--selftest")) {
  const r = runAnalyticsSelftest();
  process.exit(r.fail === 0 ? 0 : 1);
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = path.resolve(ROOT, val("--file") ?? "worklog.md");
let text;
try {
  text = readFileSync(FILE, "utf8");
} catch (e) {
  console.error(`ABORT: cannot read ${FILE}: ${e?.message ?? e}`);
  process.exit(2);
}

const parsed = parseWorklog(text);
const stats = computeStats(parsed);
const previousLineCount = val("--previous-lines") ? Number(val("--previous-lines")) : null;
const minLines = val("--min-lines") ? Number(val("--min-lines")) : null;
const anomalies = detectAnomalies(stats, { text, previousLineCount, minLines });

if (has("--json")) {
  const payload = {
    at: new Date().toISOString(),
    file: path.basename(FILE),
    ...stats,
    previousLineCount,
    minLines,
    anomalies,
  };
  const out = JSON.stringify(payload, null, 2);
  if (val("--out")) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.resolve(ROOT, val("--out")), out + "\n");
    console.log(`written: ${val("--out")}`);
  } else {
    console.log(out);
  }
} else {
  console.log(`worklog-analytics · ${path.basename(FILE)} · ${stats.lineCount} lines · ${stats.totalBlocks} blocks`);
  console.log("");
  console.log("Agents (blocks):");
  for (const a of stats.topAgents) console.log(`  ${a.agent}: ${a.blocks}`);
  console.log("");
  console.log(`Avg work bullets/block: ${stats.avgWorkBullets}`);
  console.log(`Blocks missing Stage Summary: ${stats.blocksMissingSummary}`);
  if (stats.duplicates.length) {
    console.log(`Duplicate Task IDs: ${stats.duplicates.map((d) => `${d.taskId}×${d.count}`).join(", ")}`);
  }
  console.log("");
  if (anomalies.length === 0) {
    console.log("ANOMALIES: none — append-only integrity clean");
  } else {
    console.log(`ANOMALIES (${anomalies.length}):`);
    for (const a of anomalies) console.log(`  [${a.kind}] ${a.detail}`);
  }
}

process.exit(anomalies.some((a) => a.kind === "append-only-shrink" || a.kind === "below-floor" || a.kind === "no-blocks") ? 1 : 0);
