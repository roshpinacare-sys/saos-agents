# saos-agents

> Self-measuring agent orchestration core — a task graph that cannot be lied to,
> an operator decision queue that cannot die silently, and append-only worklog
> telemetry that treats shrinkage as an alarm.

**Status:** battle-tested daily inside a live multi-agent fleet · **License:** MIT · **Runtime:** Bun or Node ≥ 18 · **Dependencies:** zero

---

## What's here

| Path | What it guarantees |
|---|---|
| `src/taskgraph.mjs` | Task graph with a strict transition table, dependency-aware ready-queue (priority → oldest-first), weighted progress and cycle detection — and the core law: **done-only-via-verified-push**. A task can only reach `done` with fresh green selftest evidence **plus** a recorded push that is provably related to the task's commit. Refusal is named and loud (`DONE-GATE-REFUSED`). |
| `src/decisionqueue.mjs` | Operator decisions as first-class objects: recommended option first, matching by index / exact text / unique prefix (ambiguous prefixes are honestly refused with `AMBIGUOUS`), `settle` only after the real-world effect, `reopen` with the reason preserved in history, `cancel` when unnecessary. |
| `src/worklog-intel.mjs` | Measured telemetry over an append-only worklog ledger: block parsing, per-agent stats, duplicate detection, missing-summary counts — and **by-construction** detection of append-only violations (`append-only-shrink`, `below-floor`, `no-trailing-newline`). Pure module: no fs, no network. |
| `cli/task-console.mjs` | Thin CLI over the modules: atomic writes (temp + rename), corrupt-file quarantine (`.corrupt-<ts>` instead of crash-loop), honest evidence computed from the tree, and a **seeded deterministic drill** of the full task lifecycle. |
| `cli/worklog-analytics.mjs` | Read-only analytics CLI: human summary or a stable `--json` machine channel, with an exit-code contract CI can gate on. |
| `test/selftest.mjs` | Deterministic offline vectors (55+). The file enforces lineage floors on itself — a smaller test that still passes is treated as a lie. |
| `tools/` | Generic git-safety CLI trio: conflict forecasting **before** the push (merge-tree dry-run), divergence visibility (never force), and a transport-refusing environment for agent-run processes. |
| `docs/PATTERNS.md` | The ten transferable patterns behind this core, and the failure family each one answers. |
| `docs/STATE-CONTRACT.md` | The machine-channel contract: who writes what, where, and how fresh it must be. |
| `SECURITY.md` | Reporting policy + the hardening posture (zero deps, offline vectors, transport refusal). |

## Quick start

```bash
bun test/selftest.mjs                  # module vectors (expect SELFTEST n/n PASS)
bun cli/worklog-analytics.mjs --selftest
bun cli/task-console.mjs drill --seed 252   # full lifecycle, deterministic

# every command above also runs on plain node ≥ 18 — zero transpile, zero deps

# your own ledger (creates state/ on first write; corrupt files quarantine themselves)
bun cli/task-console.mjs task-add "first task" --priority 5
bun cli/task-console.mjs tasks
bun cli/task-console.mjs progress

# analytics over any append-only worklog
bun cli/worklog-analytics.mjs --file worklog.md --json
```

## Git-safety tools

```bash
git remote add origin git@github.com:you/your-repo.git

bash tools/divergence-check.sh main        # measure ahead/behind; never force
bash tools/forecast-conflicts.sh main      # predict conflict files BEFORE pushing
bash tools/gitsafety-env.sh git ls-remote https://github.com/anything.git
# → fatal: transport 'https' not allowed   (the env layer refuses by itself)
```

## The core law: done-only-via-verified-push

The structural cure for a whole family of multi-agent regressions (an automated
sweeper silently disabling code, a worklog being overwritten, a task closed
because *someone else's* push was miscounted as evidence):

1. `done` requires fresh (`< 24h`) green selftest evidence **and** a fresh
   recorded push **and**, when the task carries a commit, that commit must be
   the pushed head or its ancestor — "another agent's push of different content
   never certifies work that never left the tree".
2. There is no bypass — not even for the operator. The operator's power is
   `cancel`, not evidence forgery.
3. The gate lives in the pure module (`checkDoneEvidence`), so it is tested
   offline, deterministically, and cannot be negotiated with at runtime.

## Design laws

1. **Append-only ledger** — history shrinks only through measured restoration
   from lineage, never through editing. Shrinkage is an anomaly, alarm, never
   silence.
2. **Corrupt = quarantine, not crash-loop** — a state file that cannot be
   parsed is moved to `.corrupt-<ts>` and the system starts clean.
3. **One writer per file** — every machine channel in `docs/STATE-CONTRACT.md`
   has exactly one writer; everything else reads.
4. **Atomic writes + writer lock** — temp + rename, everywhere state is persisted. The
   per-file writer lock (O_EXCL, stale-takeover) makes read-modify-write safe across
   concurrent processes: atomic rename alone prevents corruption but **not** lost
   updates (measured: 20 parallel writers → 11 survivors without the lock, 20/20 with it).
5. **Honest refusals have names** — `DONE-GATE-REFUSED`, `AMBIGUOUS`,
   `NOT-OPEN`, `NO-MATCH` — so machines and humans see *why*, not just *no*.
6. **Measure, don't claim** — evidence is computed from the tree at decision
   time; assertions without artifacts are treated as false.

## עברית

הליבה-הריבונית-לתיאום-סוכנים: גרף-משימות-שלא-ניתן-לרמות אותו (משימה-נסגרת-רק-דרך
דחיפה-מאומתת), תור-החלטות-שמפעיל-עונה-בו (המומלץ-ראשון, סירוב-כנה, reopen-עם-סיבה),
וטלמטריה-מדודה-על-ledger-אפנד-אונלי (התכווצות = אזעקה, לעולם-לא-שתיקה).
הכל-מודולים-טהורים עם וקטורים-דטרמיניסטיים, אפס-תלויות, כתיבה-אטומית והסגר-קורום.

## Provenance

The patterns here were distilled from studying public orchestration
architectures (including a study pass over the Foreman orchestrator in
`blendi-remade/agentcraft`) and rebuilt from scratch for a live autonomous
fleet — no upstream code was copied. Every module ships exactly the code its
vectors test.

## CI

The local gate is one command:

```bash
bun test/selftest.mjs && bun cli/worklog-analytics.mjs --selftest && bun cli/task-console.mjs drill --seed 252
```

A ready-to-activate GitHub Actions workflow ships at `docs/ci.example.yml`
(activating it requires a token with the `workflow` scope).

## License

MIT — see [LICENSE](LICENSE).
