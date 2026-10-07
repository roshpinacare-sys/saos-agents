# PATTERNS — ten transferable patterns for self-measuring agent orchestration

> Distilled from studying public orchestration architectures and from the
> measured failure history of a live multi-agent fleet. Each pattern exists
> because a specific, real regression family exists.

## The failure families (the measured enemy)

| Family | Symptom | Cure |
|---|---|---|
| Silent sweeper | an automated role commits sweeps that disable or delete working code | done-only-via-verified-push + append-only ledger with shrinkage alarms |
| History forgery | ledger overwritten; "a smaller test that still passes" | lineage floors + by-construction anomaly detectors |
| Silent stop | a risky action halts the pipeline with no visible trace | DecisionQueue: actions surface as decisions, never as silence |
| Miscounted evidence | agent A's push certifies agent B's unpushed work | evidence bound to the task's own commit (ancestor check) |
| Crash loops | corrupt state file crashes the process forever | quarantine (`.corrupt-<ts>`) and clean start |
| Predictable conflicts | agents collide at push time, after the work is done | forecast conflicts before the work (dry-run merge-tree) |

## The ten patterns

1. **Atomic state + quarantine** — persist via temp file + rename; a corrupt
   file moves to `.corrupt-<ts>` and the system starts clean. Downtime is a
   non-event, not a crash loop.
2. **Snapshot/upsert machine channels** — every consumer reads a stable,
   versioned contract (JSON with an explicit freshness requirement), never
   scraped prose.
3. **Task graph with done-only-via-verified-push** — the terminal transition
   is gated on fresh green selftest evidence plus a recorded, commit-bound
   push. No bypass exists; the operator's power is `cancel`, not forgery.
4. **DecisionQueue** — recommended option first; answers match by id, exact
   text, or unique prefix (ambiguity is refused by name); settle only after
   the real-world effect; reopen keeps the reason in history.
5. **Conflict forecasting** — predict conflicting files *before* the push
   (dry-run merge), so the cure is a rebase, not a post-mortem.
6. **Layered git safety** — protocol denial via environment, policy files,
   and tool-level interception; the deepest layer makes "git, fetch that
   random URL" refuse *itself*.
7. **Per-tool telemetry with rotation + staleness dimming** — feed every
   tool call into rotating JSONL; stale feeds dim, they don't disappear.
8. **Visible-to memory** — shared notes with explicit visibility scoping, so
   agents inherit context without leaking it sideways.
9. **Seeded deterministic drills** — a full lifecycle rehearsal with a fixed
   seed, zero network, zero clock: proof of correctness at zero cost.
10. **Docs generated from the contract** — documentation of state channels is
    generated (or CI-checked) against the code that writes them, so it cannot
    rot silently.

## The meta-law

**Measure, don't claim.** Every safety property above is enforced by
deterministic offline vectors (`test/selftest.mjs`), not by documentation.
The selftest enforces floors on *itself* — because the enemy is measured:
a smaller test that still passes is a lie, not a success.
