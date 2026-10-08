/* R253 · TASKGRAPH — גרף-משימות-ריבוני (זיקוק-מ-agentcraft-Foreman, גל-2).
 *
 * התרופה-המבנית-למשפחת-ה-regressions-ההיסטורית (custodian-משתיק-קוד — 95e90d2,
 * דריסת-worklog — c60ebae): **משימה נסגרת רק דרך דחיפה מאומתת** — done-only-via-
 * verified-push. המודול-טהור (אין-fs/רשת): ה-CLI (scripts/task-console.mjs) מזריק
 * ראיות-אמת מ-selftest-last-run.json ו-push-custody.json; ה-selftest בודק-אותו-אופליין.
 *
 * טבלת-המעברים: todo→doing|cancelled · doing→review|blocked|todo|cancelled ·
 * review→doing|done|blocked|cancelled · blocked→todo|doing|cancelled · done/cancelled=טרמינליים.
 */

export const STATUSES = ["todo", "doing", "review", "done", "blocked", "cancelled"];
export const TRANSITIONS = {
  todo: ["doing", "cancelled"],
  doing: ["review", "blocked", "todo", "cancelled"],
  review: ["doing", "done", "blocked", "cancelled"],
  blocked: ["todo", "doing", "cancelled"],
  done: [],
  cancelled: [],
};
export const WEIGHTS = { done: 1.0, review: 0.75, doing: 0.4, blocked: 0.1, todo: 0, cancelled: 0 };

/* R260 · machine-channel ordering law: code-unit compare, NEVER localeCompare —
 * measured: localeCompare("a","B") = -1 (ICU) while code-unit says B<a; an ICU-less node
 * build (or a different ICU version) reorders ready()/queues again. Operator queues are a
 * machine contract — they may not depend on the environment's collation. */
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

export function createTask({ id, title, priority = 0, deps = [], assignee = null, commit = null, createdAt }) {
  if (!id || !title) throw err("INVALID-TASK", "id ו-title חובה");
  /* R264 · חוק-קנון-ה-id: id הוא-מפתח-מכונה — מנורמל-NFC (ה-normalize של ECMA-262
   * מוגדר-בספק ואינו-תלוי-ICU; אומת-בייט-זהה bun↔node), כך שתאומים-בעלי-חזות
   * זהה ("café" מול "cafe"+U+0301) לעולם לא יעקפו זיהוי-כפילויות. נמדד-חי: שני
   * התאומים התקבלו כשתי משימות-שונות. deps מנורמלים-כך-שהפניה תמיד תמצא את
 * ה-id-הקנוני; הכותרת נשארת מילולית-בייט — תוכן-המשתמש לא-משתנה בשקט. */
  const canonId = String(id).normalize("NFC");
  const canonDeps = deps.map((d) => String(d).normalize("NFC"));
  for (const d of canonDeps) if (d === canonId) throw err("SELF-DEP", `משימה ${canonId} תלויה-בעצמה`);
  const at = createdAt ?? new Date().toISOString();
  return {
    id: canonId, title,
    status: "todo",
    priority: Number(priority) || 0,
    deps: [...new Set(canonDeps)],
    assignee,
    commit,
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    doneAt: null,
    statusHistory: [{ from: null, to: "todo", at }],
  };
}

/* ── שער-ה-done: אף-משימה לא נסגרת בלי selftest-ירוק-וטרי + דחיפה-מאומתת-בשער ── */
export function checkDoneEvidence(task, evidence) {
  const reasons = [];
  if (!evidence || typeof evidence !== "object") reasons.push("אין-ראיות-כלל");
  else {
    if (evidence.selftestGreen !== true) reasons.push("selftest-לא-ירוק");
    if (evidence.selftestFresh !== true) reasons.push("selftest-לא-טרי (>24h)");
    if (evidence.pushRecorded !== true) reasons.push("אין-ראיה-לדחיפה-דרך-השער");
    if (task.commit && Array.isArray(evidence.pushShas) && !evidence.pushShas.includes(task.commit)) {
      reasons.push(`ה-commit-של-המשימה (${String(task.commit).slice(0, 7)}) לא-בראיית-הדחיפה`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

function err(code, message) {
  const e = new Error(`${code}: ${message}`);
  e.code = code;
  return e;
}

export function setStatus(graph, id, to, opts = {}) {
  const task = graph.tasks.find((t) => t.id === id);
  if (!task) throw err("NO-TASK", `אין-משימה ${id}`);
  if (!STATUSES.includes(to)) throw err("BAD-STATUS", `סטטוס-לא-מוכר: ${to}`);
  if (!canTransition(task.status, to)) {
    throw err("ILLEGAL-TRANSITION", `${task.status}→${to} אסור-בטבלת-המעברים`);
  }
  if (to === "done") {
    const verdict = checkDoneEvidence(task, opts.evidence);
    if (!verdict.ok) {
      throw err("DONE-GATE-REFUSED", `done-only-via-verified-push: ${verdict.reasons.join(" · ")}`);
    }
  }
  const at = opts.at ?? new Date().toISOString();
  task.statusHistory.push({ from: task.status, to, at, ...(opts.reason ? { reason: opts.reason } : {}) });
  task.status = to;
  task.updatedAt = at;
  if (to === "doing" && !task.startedAt) task.startedAt = at;
  if (to === "done") task.doneAt = at;
  if (opts.commit !== undefined) task.commit = opts.commit;
  return task;
}

/* ── תור-ה-ready: deps-כולם-done, ממוין עדיפות-יורדת ואז-הוותיק-ראשון ── */
export function ready(graph) {
  const byId = new Map(graph.tasks.map((t) => [t.id, t]));
  return graph.tasks
    .filter((t) => t.status === "todo")
    .filter((t) => t.deps.every((d) => byId.get(d)?.status === "done"))
    .sort((a, b) => b.priority - a.priority || cmpStr(String(a.createdAt), String(b.createdAt)) || cmpStr(a.id, b.id)); // R260: code-unit, ICU-free
}

export function progress(graph) {
  const live = graph.tasks.filter((t) => t.status !== "cancelled");
  if (live.length === 0) return 0;
  return Math.round((live.reduce((s, t) => s + (WEIGHTS[t.status] ?? 0), 0) / live.length) * 1000) / 1000;
}

/* ── ולידציה: כפילויות/סטטוסים-לא-מוכרים/deps-חסרים/מחזוריות ── */
export function validateGraph(graph) {
  const errors = [];
  const seen = new Set();
  for (const t of graph.tasks ?? []) {
    if (seen.has(t.id)) errors.push(`כפילות-id: ${t.id}`);
    seen.add(t.id);
    if (!STATUSES.includes(t.status)) errors.push(`סטטוס-לא-מוכר: ${t.id}=${t.status}`);
    /* R260 · structural junk flowed straight through (measured: hand-merged state with a
     * missing priority rendered as "Pundefined", string deps iterated char-by-char) —
     * shape is law, named refusals over silent weirdness. */
    if (typeof t.title !== "string" || !t.title) errors.push(`כותרת-פגומה: ${t.id}`);
    if (!Array.isArray(t.deps)) errors.push(`deps-לא-מערך: ${t.id}`);
    if (!Number.isFinite(Number(t.priority))) errors.push(`עדיפות-פגומה: ${t.id}`);
    /* R264 · חוק-צורת-ה-id: state-ממוזג-יד שנשא id לא-מחרוזת / ריק / לא-מנורמל-NFC
     * עבר-בשקט (נמדד-חי: id-מספרי-123 ותאום-NFD התקבלו עם rc=0 וכתיבה-על-גביהם
     * המשיכה) — הצורה היא-חוק, סירוב-נקוב על-פני-מוזרות-שקטה. */
    if (typeof t.id !== "string" || !t.id) errors.push(`id-פגום: ${String(t.id)}`);
    else if (t.id !== t.id.normalize("NFC")) errors.push(`id-אינו-מנורמל-NFC: ${t.id}`);
  }
  for (const t of graph.tasks ?? []) {
    for (const d of Array.isArray(t.deps) ? t.deps : []) {
      if (!seen.has(d)) errors.push(`dep-חסר: ${t.id}→${d}`);
      if (d === t.id) errors.push(`תלות-עצמית: ${t.id}`);
    }
  }
  if (hasCycle(graph)) errors.push("מחזוריות-בתלות (cycle)");
  return { ok: errors.length === 0, errors };
}

export function hasCycle(graph) {
  const byId = new Map((graph.tasks ?? []).map((t) => [t.id, t]));
  const state = new Map(); // 1=בביקור 2=נגמר
  const visit = (id) => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const d of byId.get(id)?.deps ?? []) if (visit(d)) return true;
    state.set(id, 2);
    return false;
  };
  for (const t of graph.tasks ?? []) if (visit(t.id)) return true;
  return false;
}

export function serialize(graph) {
  return JSON.stringify(graph, null, 2);
}

export function deserialize(json) {
  const g = typeof json === "string" ? JSON.parse(json) : json;
  const v = validateGraph(g);
  if (!v.ok) throw err("INVALID-GRAPH", v.errors.join(" · "));
  return g;
}

/* ── drill מוזרע (גל-3-בזעיר): חזרה-דטרמיניסטית על-מחזור-החיים-המלא, אפס-git/רשת ── */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GOOD_EVIDENCE = (shas = []) => ({ selftestGreen: true, selftestFresh: true, pushRecorded: true, pushShas: shas });

export function runDrill(seed = 252) {
  const rnd = mulberry32(seed);
  const at0 = "2026-10-07T00:00:00Z";
  const stamp = (i) => new Date(Date.parse(at0) + i * 60000).toISOString();
  const g = { tasks: [], seed, law: "done-only-via-verified-push" };
  const steps = [];
  const mk = (id, title, priority, deps) => {
    g.tasks.push(createTask({ id, title, priority, deps, createdAt: stamp(0) }));
  };
  mk("D-A", "תשתית-ראשונה", 5, []);
  mk("D-B", "תלוי-ב-A", 3, ["D-A"]);
  mk("D-C", "מקביל-בעדיפות-נמוכה", 1, []);
  // ערפול-מוזרע של-עדיפות-D-C — ה-drill מוכיח-שהסדר-דטרמיניסטי-לפי-הזרע
  g.tasks.find((t) => t.id === "D-C").priority = Math.floor(rnd() * 2) + 1;
  let i = 1;
  const step = (line) => steps.push(`[${String(i++).padStart(2, "0")}] ${line} · progress=${progress(g)}`);

  step(`ready(ראשוני)=${ready(g).map((t) => t.id).join(",")}`);
  setStatus(g, "D-A", "doing", { at: stamp(1) });
  setStatus(g, "D-A", "review", { at: stamp(2) });
  const sha = `sha-drill-${seed.toString(16)}`;
  g.tasks.find((t) => t.id === "D-A").commit = sha;
  try {
    setStatus(g, "D-A", "done", { at: stamp(3), evidence: null });
    step("!! שער-ה-done נפל — זה-כשל-בטיחות");
    return { ok: false, g, steps };
  } catch (e) {
    step(`שער-done-דחה-בלי-ראיות (${e.code}) — תקין`);
  }
  setStatus(g, "D-A", "done", { at: stamp(4), evidence: GOOD_EVIDENCE([sha]) });
  step(`D-A=done-דרך-השער (push=${sha.slice(0, 10)}) · ready=${ready(g).map((t) => t.id).join(",")}`);
  setStatus(g, "D-B", "doing", { at: stamp(5) });
  setStatus(g, "D-C", "doing", { at: stamp(6) });
  setStatus(g, "D-C", "blocked", { at: stamp(7), reason: "הדגמת-חסימה" });
  setStatus(g, "D-B", "review", { at: stamp(8) });
  setStatus(g, "D-B", "done", { at: stamp(9), evidence: GOOD_EVIDENCE([sha]) });
  step("D-B=done-דרך-השער");
  setStatus(g, "D-C", "todo", { at: stamp(10), reason: "חזרה-מחסימה" });
  step(`סופי: ${g.tasks.map((t) => `${t.id}=${t.status}`).join(" ")}`);
  const v = validateGraph(g);
  return { ok: v.ok, g, steps, validation: v };
}
