/* R253 · DECISIONQUEUE — תור-ההחלטות-למפעיל (זיקוק-מ-agentcraft-Foreman, גל-2).
 *
 * העיקרון: פעולה-מסוכנת/מחייבת-מפעיל לא נעצרת-בשקט ולא נעשית-בעקיפין — היא יוצאת
 * כ**החלטה**-גלויה: question/permission/merge, options-עם-המומלץ-ראשון, תשובה
 * מדויקת (מזהה/טקסט-מלא/קידומת-ייחודית), settle-רק-אחרי-אפקט-בפועל, reopen-בסירוב
 * ("Merge refused: <reason>") ו-cancel-כשההחלטה-מיותרת. הכל-נשמר-בהיסטוריה.
 * מודול-טהור (אין-fs/רשת); ה-CLI: scripts/task-console.mjs (persist אטומי).
 */

export const KINDS = ["question", "permission", "merge"];
export const DQ_STATUSES = ["open", "answered", "settled", "cancelled"];

function err(code, message) {
  const e = new Error(`${code}: ${message}`);
  e.code = code;
  return e;
}

export function createDecision({ id, kind, question, options = [], context = null, taskId = null, createdAt }) {
  if (!id) throw err("INVALID-DECISION", "id חובה");
  if (!KINDS.includes(kind)) throw err("BAD-KIND", `סוג-לא-מוכר: ${kind}`);
  if (!question || typeof question !== "string") throw err("INVALID-DECISION", "question חובה");
  const opts = options.map((label) => ({ label: String(label), recommended: false }));
  if (opts.length) opts[0].recommended = true; // המומלץ-ראשון — חוק-המקור
  const at = createdAt ?? new Date().toISOString();
  return {
    id, kind, question,
    options: opts,
    context,
    taskId,
    status: "open",
    answer: null,
    statusHistory: [{ from: null, to: "open", at }],
    createdAt: at,
    decidedAt: null,
    settledAt: null,
  };
}

/* ── matching: מזהה-מספרי (1-based) / טקסט-מלא (חסר-רגישות-מקרה) / קידומת-ייחודית ── */
export function matchOption(options, input) {
  const s = String(input ?? "").trim();
  if (/^\d+$/.test(s)) {
    const i = Number(s) - 1;
    if (i < 0 || i >= options.length) throw err("NO-MATCH", `אין-אפשרות מספר ${s}`);
    return i;
  }
  const norm = (x) => x.toLowerCase().replace(/\s+/g, " ");
  const exact = options.findIndex((o) => norm(o.label) === norm(s));
  if (exact >= 0) return exact;
  const hits = options.map((o, i) => (norm(o.label).startsWith(norm(s)) ? i : -1)).filter((i) => i >= 0);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw err("AMBIGUOUS", `הקידומת "${s}" דו-משמעית (${hits.length} התאמות)`);
  throw err("NO-MATCH", `אין-התאמה ל"${s}"`);
}

const find = (dq, id) => {
  const d = (dq.decisions ?? []).find((x) => x.id === id);
  if (!d) throw err("NO-DECISION", `אין-החלטה ${id}`);
  return d;
};

export function answerDecision(dq, id, { by = "operator", optionIndex = null, optionText = null, text = null, at } = {}) {
  const d = find(dq, id);
  if (d.status !== "open") throw err("NOT-OPEN", `${id} במצב ${d.status} — לא-ניתן-לענות`);
  let idx = null;
  let chosen = null;
  if (optionIndex !== null && optionIndex !== undefined) {
    // API מתוכנת: 0-based. הקלט-האנושי (1-based) עובר-דרך optionText/matchOption.
    idx = Number(optionIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= d.options.length) {
      throw err("NO-MATCH", `אין-אפשרות במזהה ${optionIndex} (0..${d.options.length - 1})`);
    }
    chosen = d.options[idx].label;
  } else if (optionText !== null && optionText !== undefined) {
    idx = matchOption(d.options, optionText);
    chosen = d.options[idx].label;
  }
  const when = at ?? new Date().toISOString();
  d.answer = { ...(chosen ? { optionIndex: idx, option: chosen } : {}), ...(text ? { text: String(text) } : {}), by, at: when };
  d.statusHistory.push({ from: d.status, to: "answered", at: when });
  d.status = "answered";
  d.decidedAt = when;
  return d;
}

export function settleDecision(dq, id, { at } = {}) {
  const d = find(dq, id);
  if (d.status !== "answered") throw err("NOT-ANSWERED", `${id} במצב ${d.status} — settle רק-אחרי-תשובה (האפקט-בפועל-קודם)`);
  const when = at ?? new Date().toISOString();
  d.statusHistory.push({ from: d.status, to: "settled", at: when });
  d.status = "settled";
  d.settledAt = when;
  return d;
}

export function reopenDecision(dq, id, reason, { by = "operator", at } = {}) {
  const d = find(dq, id);
  if (d.status === "open") throw err("ALREADY-OPEN", `${id} כבר-פתוחה`);
  if (d.status === "cancelled") throw err("CANCELLED", `${id} בוטלה — אין-reopen (ליצור-החלטה-חדשה)`);
  const when = at ?? new Date().toISOString();
  d.statusHistory.push({ from: d.status, to: "open", at: when, reason: String(reason ?? "נדחה-ללא-סיבה-מתועדת") });
  d.status = "open";
  d.answer = null;
  d.decidedAt = null;
  return d;
}

export function cancelDecision(dq, id, reason, { at } = {}) {
  const d = find(dq, id);
  if (d.status === "settled") throw err("SETTLED", `${id} הושלמה — אין-cancel`);
  const when = at ?? new Date().toISOString();
  d.statusHistory.push({ from: d.status, to: "cancelled", at: when, reason: String(reason ?? "") });
  d.status = "cancelled";
  return d;
}

export function listOpen(dq) {
  return (dq.decisions ?? [])
    .filter((d) => d.status === "open")
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
}

export function validateDQ(dq) {
  const errors = [];
  const seen = new Set();
  for (const d of dq.decisions ?? []) {
    if (seen.has(d.id)) errors.push(`כפילות-id: ${d.id}`);
    seen.add(d.id);
    if (!KINDS.includes(d.kind)) errors.push(`סוג-לא-מוכר: ${d.id}=${d.kind}`);
    if (!DQ_STATUSES.includes(d.status)) errors.push(`סטטוס-לא-מוכר: ${d.id}=${d.status}`);
    if (d.status === "answered" && !d.answer) errors.push(`answered-בלי-תשובה: ${d.id}`);
    if (d.status === "settled" && !d.answer) errors.push(`settled-בלי-תשובה: ${d.id}`);
  }
  return { ok: errors.length === 0, errors };
}

export function serializeDQ(dq) {
  return JSON.stringify(dq, null, 2);
}

export function deserializeDQ(json) {
  const dq = typeof json === "string" ? JSON.parse(json) : json;
  const v = validateDQ(dq);
  if (!v.ok) throw err("INVALID-DQ", v.errors.join(" · "));
  return dq;
}
