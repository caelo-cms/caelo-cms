# Coverage — the test-coverage gate

The coverage gate enforces CLAUDE.md §6 (*"Coverage gates in CI: unit ≥ 90%, integration ≥ 80% of declared Query API ops"*). It runs in the `check` job of `.github/workflows/ci.yml` as the `Test + coverage gate` step, replacing the old bare `bun test --isolate`, and uploads its output as the `coverage-report` artifact. Source: `scripts/coverage-check.ts` + `scripts/coverage-thresholds.json`.

## Running it

```bash
bun run coverage:check   # the full gate (needs Postgres up for the integration tier)
bun run coverage         # raw `bun test --coverage` for a quick local look
```

The gate runs the suite in two passes and writes `coverage/coverage-summary.json` (and, in CI, a markdown table to the Actions job summary). It exits non-zero when either tier is below its floor.

## The two tiers and their metrics

Tests are split **by file suffix** — reusing the convention already in the repo, so nothing was renamed:

- **Unit tier** — every `*.test.ts` that is *not* `*.integration.test.ts`. Metric: **pooled lcov line coverage** (`Σ LH / Σ LF` across all records) from `bun test --coverage`. Bun's lcov already omits the test files themselves, so the denominator is source lines.
- **Integration tier** — `*.integration.test.ts`. Metric: **op-coverage** = (declared Query API ops exercised) ÷ (declared ops). This is §6's exact wording — *not* integration line coverage.

Name a new test `*.integration.test.ts` only if it touches Postgres; otherwise it's a unit test.

## How op-coverage is measured

The integration pass runs with `CAELO_OP_COVERAGE=1`. Under that flag — and **only** under it — `defineOperation` (`packages/query-api/src/operation.ts`) wraps each op's handler to append the op name to `coverage/op-coverage.jsonl` on first invocation. It is the one chokepoint common to both the `execute(registry, adapter, ctx, "name", …)` dispatch path and the direct `op.handler(...)` calls that many integration tests use, so every exercised op is captured regardless of how the test invokes it.

Because the integration pass runs under `bun test --isolate` (each file gets a fresh JS global for the per-file Postgres reset in `scripts/test-preload.ts`), an in-memory set would reset per file. The recorder therefore **appends** to the on-disk `.jsonl` (`O_APPEND`); the gate unions and de-dupes the lines. The declared-op denominator comes from `registerAdminOps(new OperationRegistry()).names()` — the same registry the runtime uses, so it can never drift from what ships.

When the flag is unset (production, plain `bun test`), `defineOperation` returns its argument unchanged — zero overhead, byte-for-byte identical behaviour.

## Floors, targets, and the ratchet

`scripts/coverage-thresholds.json` holds the enforced **floors** plus the §6 **targets**:

```json
{ "unitLinePct": 33, "integrationOpPct": 42, "target": { "unitLinePct": 90, "integrationOpPct": 80 } }
```

The 90/80 figures are the goal. What CI enforces is the floor, seeded *below* current coverage (baseline at introduction: unit 34.1%, integration 43.2% = 153/354 ops) with a downward margin so the gate is green at merge and a benign fluctuation can't red the build. The gate fails only when a tier drops **below its floor**.

**The ratchet:** when you add tests and coverage rises, raise the matching floor in the same PR — a deliberate one-line edit, never automatic. Lowering a floor needs an explicit justification in the PR description. Over time the floors climb toward the `target` block.

## Reading a failure

- **A tier below floor** — the step prints `FAIL <tier>: <measured>% (floor <floor>%)`. For the integration tier it also lists up to 25 declared ops that were never exercised; add an integration test for those (or, if the drop is intentional and justified, adjust the floor).
- **A failing test** — the gate propagates the underlying `bun test` exit code; fix the test first, coverage is moot until the suite is green.
- **`no … line-coverage data` / `declared op set is empty`** — the gate fails loud (CLAUDE.md §2) rather than reporting a fake 0%; it means the lcov wasn't produced or the op registry failed to load, not that coverage is zero.

The `coverage-report` artifact (lcov + `coverage-summary.json`) is uploaded even when the gate fails (`if: always()`), so you can inspect the numbers from the Actions run.

## What this gate does NOT do

- **Per-file thresholds** — codebase-level only for v1.
- **E2E / Playwright coverage** — structurally harder against the real stack; out of scope.
- **Auto-ratcheting** — floors never rise automatically; raising one is a human PR edit.
