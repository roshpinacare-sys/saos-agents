# STATE CONTRACT — machine channels for the live console

> The console never scrapes prose. It reads stable machine channels. This
> document defines what exists, who writes it, and how fresh it must be.

## 1 · Channels

| Channel | Content | Sole writer | Freshness |
|---|---|---|---|
| `state/selftest-last-run.json` | full selftest result `{pass, fail, at, vectors}` | `test/selftest.mjs` (full runs only) | < 24h |
| `state/push-custody.json` | last verified push `{lastPushedSha, pushedAt, branch, method}` | the push gate only | < 24h (for the done-gate) |
| `state/tasks.json` | task graph `{tasks[], seed?, law}` | `cli/task-console.mjs` only | per-task `updatedAt` |
| `state/decisions.json` | decision queue `{decisions[]}` | `cli/task-console.mjs` only | `listOpen` computed on read |
| `bun cli/worklog-analytics.mjs --json` | ledger telemetry `{totalBlocks, perAgent, duplicates, anomalies}` | read-only (zero writes by default) | computed at read time |

## 2 · Write laws

1. **One writer per file** — `tasks.json` / `decisions.json` are written only
   through the task console (atomic: temp + rename, serialized by a per-file
   writer lock with stale-takeover, so concurrent console processes never lose
   updates). Push custody is written
   only by the push gate. The selftest marker is written only at the end of a
   full selftest run.
2. **Corrupt = quarantine, not crash-loop** — an unparseable file moves to
   `<file>.corrupt-<ts>`; the system starts clean.
3. **The ledger is append-only** — analytics report shrinkage as an anomaly;
   any decrease in lines requires measured restoration from lineage.
4. **Exit-code contract** — `worklog-analytics` exits `1` on
   `append-only-shrink` / `below-floor` / `no-blocks`, so CI can gate on it.

## 3 · The done-gate (done-only-via-verified-push)

A task may move `review → done` only if all of the following are *measured
from the tree at request time*:

- `state/selftest-last-run.json`: `fail == 0` **and** `at` fresh (< 24h)
- `state/push-custody.json`: `lastPushedSha` present **and** `pushedAt` fresh (< 24h)
- if the task carries a `commit`, it must appear in the push evidence (the
  pushed head, or its ancestor)

Refusal is `DONE-GATE-REFUSED` with the list of missing evidence. There is no
bypass mechanism — not even for the operator (whose power is `cancel`, not
evidence forgery).

## 4 · DecisionQueue

Operator-binding actions surface as visible decisions, never silent stops:

- `options` — recommended first, marked `recommended: true`
- `decision-answer` — by numeric id / exact text / unique prefix (ambiguous = refused)
- `settle` — only after the real-world effect · `reopen` — with a recorded
  reason in history · `cancel` — when unnecessary
- consoles render `decisions.json` — oldest open first
