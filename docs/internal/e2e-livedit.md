# e2e-livedit — Real-AI Playwright suite (issue #47)

Drives the editor chat against the live Anthropic API
(`claude-opus-4-7`, `temperature: 0`) and verifies the Live Edit
chat → Stage → Publish → re-edit loop end-to-end. Catches the
regression classes the mock-AI suite at `apps/admin/e2e/` cannot:

- v0.10.17 — AI emits intent then stops without action (empty response).
- v0.10.19 — orphan locks in `chat_entity_locks` after Stage.
- v0.10.20 — `set_nav_menu` JSON-Schema mismatch (covered by Scenario
  2 in v0.13.1; helper surface ready).
- v0.10.21 — missing nav-menu primer (covered by Scenario 2 in
  v0.13.1).

All mid-flow assertions are deterministic (DOM via Playwright, DB via
`bun:SQL`, admin-stderr greps). The only AI call in the verification
path is the closing vision verdict on the published page.

## Running locally

The suite needs:

1. **A clean compose stack.** `docker compose up -d` from the repo
   root brings up Postgres + the two Caddy vhosts (`:8081` staging,
   `:8082` production).
2. **A real Anthropic API key.** Create `.env.test` at the repo root
   (gitignored) with:

   ```
   ANTHROPIC_API_KEY_E2E=sk-ant-...
   ```

   Use a project-scoped key, not your personal one — the suite burns
   real tokens on every run.
3. **Migrations applied.** `bun run db:migrate` if you haven't run
   the regular dev path yet.

Then from anywhere in the repo:

```sh
bun run e2e-livedit
```

The script does `svelte-kit sync && bun --bun vite build && playwright test`.
The first build is ~30 s cold; subsequent runs reuse the build cache.

### What you should see

```
[chromium] › e2e-livedit/scenario-homepage.browser.ts:N:M
  ✓ Scenario 1 — homepage from scratch (3.2 min)
```

A full run takes 3-5 min for a clean compose stack + warm bun cache.

### When it fails

Artifacts land under `apps/admin/test-results/livedit/`:

- `admin.log` — captured stdout/stderr from the spawned admin process.
  The diag-grep regression guards (`assertNoChatRunnerDiagWarnings`)
  read this file; failure messages quote the matched line.
- `playwright-report/index.html` — Playwright's HTML report with the
  trace viewer.
- `*-failed-*.png` — screenshots from any failed step.

In CI those same files upload as the
`e2e-livedit-artifacts-${run_id}-${attempt}` artifact, plus per-table
CSV dumps of `chat_messages`, `chat_entity_locks`, `pages`,
`page_modules`, `page_module_content` under `db-dump/`.

## The 10× determinism recipe (post-merge gate, AC #15)

Real-AI assertions need to pass consistently or they're flaky-by-design.
After landing a new scenario or tightening assertions, the operator
manually runs:

```sh
pass=0; fail=0
for i in $(seq 1 10); do
  if bun run e2e-livedit; then
    pass=$((pass+1))
  else
    fail=$((fail+1))
  fi
done
echo "Results: $pass passed, $fail failed (target: ≥ 9/10)"
```

If the count drops below 9/10, the assertions in
`scenario-*.browser.ts` are too tight — loosen them (substring ⇒
contains; exact count ⇒ ≥N) and re-run. The recipe is intentionally
out of CI: 10× a 5-min suite is ~50 min, only worth running when
something material changed (new scenario, new model pin, structural
edit to assertions).

## Adding a new scenario

Each scenario is a single `apps/admin/e2e-livedit/scenario-*.browser.ts`
file. Use Scenario 1 as the template; the helpers in `helpers.ts`
cover the common shape:

```ts
import {
  attachChatSessionTracker,
  awaitPublishComplete,
  awaitStageComplete,
  loginAsDevOwner,
  sendChatPromptAndWait,
  verifyPublishedPageWithVision,
  assertNoOrphanLocks,
  assertNoChatRunnerDiagWarnings,
} from "./helpers.js";

test("scenario name", async ({ page }) => {
  const start = new Date().toISOString();
  const tracker = attachChatSessionTracker(page);
  await loginAsDevOwner(page);
  await page.goto("/edit");
  await sendChatPromptAndWait(page, "<prompt>");
  const sessionId = tracker.currentSessionId();
  // structural DB + DOM assertions ...
  await awaitStageComplete(page);
  await awaitPublishComplete(page);
  const verdict = await verifyPublishedPageWithVision(page);
  expect(verdict.ok).toBe(true);
  assertNoOrphanLocks(sessionId!);
  assertNoChatRunnerDiagWarnings();
});
```

**Bias toward structural assertions.** Substrings beat exact-string
matches; `count ≥ N` beats `count === N`. The model's wording will
vary turn-to-turn even at `temperature: 0` once tools come into
play. Lean on row counts, foreign-key relationships, and
content-shape rather than literal strings the AI wrote.

## What each assertion class catches

| Assertion | Regression class |
|---|---|
| `data-turn-state="idle"` after `send()` | Stream stall, abort, IAP timeout — any case where the SSE never fires `done`. |
| `pages` row created in this scenario window | v0.10.17 empty-response — AI didn't call `add_page`. |
| `page_modules` count ≥ 3 | AI emitted intent but never called the module tools. |
| Footer `content_values::text` contains "Caelo" + "MPL 2.0" | The chat-runner persisted the AI's tool results to `page_module_content`. |
| `chat_messages` has assistant rows with `tool_calls IS NOT NULL` | Provider didn't drop tool calls in the SDK adapter. |
| `chat_entity_locks` empty after Stage / Publish | v0.10.19 orphan-lock regression. |
| No `[chat-runner] empty-response` in admin.log | v0.10.17 stderr signal. |
| No `[chat-runner] passive-response-diag` in admin.log | v0.10.21 missing-primer signal. |
| `GET <productionUrl>` returns 2xx + substring | Static-gen rendered the page; Caddy serving the production bind-mount. |
| Closing vision verdict `ok: true` | Page renders structurally (heading + body, no broken layout). |
| Same `page_modules` keys before/after re-edit | Re-edit didn't churn placements (add/delete/reorder). |
| ≥1 `page_module_content.updated_at` advanced, <total | Edit landed on one content row, not all. |
| `transcript-failure-count == 0` after a footer-nav prompt (`scenario-ai-layout-footer`) | issue #106: `add_module_to_layout` was emitted, not narrated-then-dropped — the field-schema enum gap that made `link-list` unrepresentable is closed. |
| `layout_modules` row in the `footer` block whose module has a `link-list` field (`scenario-ai-layout-footer`) | issue #106 / §1A: the footer nav is a single list field, not numbered `label1`/`label2` scalars. |

## Why the suite diverges from the issue's `docker-compose.test.yml`

The issue body proposes a Compose override that injects
`ANTHROPIC_API_KEY_E2E` into a Compose-managed admin service. The
existing `docker-compose.yml` carries only `postgres` +
`caddy-staging` + `caddy-production`; the admin runs as a host process
(`bun run build/index.js`). The current local + CI shape spawns the
admin from `apps/admin/e2e-livedit/global-setup.ts` rather than from
Compose so:

1. The test runner can capture the admin's stdout/stderr into
   `admin.log` (the diag-grep regression guards depend on it).
   Compose's `docker logs` is reachable from the host but not
   reliably from spec code without a tee daemon.
2. The existing `e2e` job in `ci.yml` already uses host-process
   admin via Playwright's `webServer` block. Mirroring that shape
   makes the new workflow obviously similar to the existing one.

If the project ever moves the admin into Compose for tests, the
global-setup spawn collapses to a single `docker compose up admin`
call and `admin.log` becomes the stream-attach output.

## Operator hand-off contract (issue's 3rd comment)

> "build and check local first, there is an API key already"

Before merging the CI workflow, run the suite locally to the green:

```sh
bun run e2e-livedit
```

PR description records the green local run output. CI is the
secondary guard — local pass is the primary one.

### CI secret gate

`.github/workflows/e2e-livedit.yml` starts with a one-step `preflight`
job that reads `secrets.ANTHROPIC_API_KEY_E2E` into an env var and
emits `enabled=true|false`. The main `e2e-livedit` job's `if:` keys
off that output:

- **Secret set →** main job runs normally; failure is real and blocks the
  PR check.
- **Secret unset →** main job is `SKIPPED` with a workflow notice
  pointing the operator at repo Settings → Secrets and variables →
  Actions. The PR check goes neutral, not red.

This means a fresh fork or a PR opened before the operator has
configured the secret doesn't fail CI on a config gap — the suite
just stays dormant until the secret arrives. Once configured, every
subsequent PR + push:main + workflow_dispatch run executes the full
real-AI flow without code changes.

## Suggested next scenarios (v0.13.1+)

- **Scenario 2** — `/hosting` page + nav-menu update. Covers v0.10.20
  (`set_nav_menu` JSON-Schema) + v0.10.21 (missing nav-menu primer)
  with concrete `structured_sets` row checks.
- **Scenario 3** — footer copyright edit + Stage/Publish round-trip
  with substring checks on the production HTML.

Both are tracked on the v0.13.1 follow-up roadmap issue (opened
when this PR is opened, per AC #19 in `.workflow-plan.md`).
