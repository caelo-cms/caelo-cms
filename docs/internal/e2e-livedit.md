# e2e-livedit — Real-AI Playwright suite (issue #47)

Drives the editor chat against the live Anthropic API
(`claude-sonnet-5`, adaptive thinking) and verifies the Live Edit
chat → Stage → Publish → re-edit loop end-to-end. Catches the
regression classes the mock-AI suite at `apps/admin/e2e/` cannot:

- v0.10.17 — AI emits intent then stops without action (empty response).
- v0.10.19 — orphan locks in `chat_entity_locks` after Stage.
- v0.10.20 / v0.10.21 — the nav-menu schema mismatch and missing
  primer. Structured sets and the `nav-menu` binding are gone (epic
  #1107); menus are shared lists, covered by `scenario-ai-layout-footer`
  and `scenario-lists-mega-menu`.

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
4. **The Playwright chromium build installed for THIS checkout.** The
   migration scenarios drive the site-importer, which screenshots the
   external site with Playwright's chromium. A fresh checkout / worktree
   often has a Playwright version whose pinned chromium build isn't in
   the shared `~/Library/Caches/ms-playwright` cache yet, so screenshots
   silently skip with a `[site-importer] Playwright chromium launch
   failed` warning. Install the repo-pinned build from the checkout you
   run the suite in:
   `bun node_modules/playwright/cli.js install chromium`
   (use the repo-pinned CLI, not `bunx playwright install` — bunx may
   fetch a mismatched registry version).
5. **Running from a git worktree?** The `caddy-staging` /
   `caddy-production` containers bind-mount `./apps/admin/output/*`
   relative to the checkout that started `docker compose`. If you run
   the suite from a *different* worktree, its Stage writes to that
   worktree's `output/` while Caddy still serves the main checkout's —
   the build-verification guard then fails Stage with a `runId`
   mismatch. Point the suite at the mounted dir:
   `export CAELO_OUTPUT_ROOT=<main-checkout>/apps/admin`.

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
- `bug-reports.json` — every `ai_bug_reports` row filed during the run.
  Worth reading even on a green run; see *AI-detected bugs per run* below.

In CI those same files upload as the
`e2e-livedit-artifacts-${run_id}-${attempt}` artifact, plus per-table
CSV dumps of `chat_messages`, `chat_entity_locks`, `pages`,
`page_modules`, `page_module_content` under `db-dump/`.

## Real AI cost per run (optimization metric)

Every run captures its actual AI spend from the `ai_calls` table so the
number can be tracked over time as an optimization signal. The
`Capture real AI cost from ai_calls` step runs `if: always()` (so red
runs still record spend) and writes
`apps/admin/test-results/livedit/ai-cost.json` — a single
`json_build_object` aggregate over `ai_calls`:

```json
{
  "totalMicrocents": 187000000,
  "calls": 14,
  "inputTokens": 512000,
  "outputTokens": 8200,
  "cachedTokens": 210000,
  "unpricedCalls": 0,
  "byModel": [{ "model": "claude-opus-4-7", "calls": 10, "microcents": 180000000 }]
}
```

Cost is stored in **microcents** (`1 USD = 1e8 microcents`), the real
per-call `cost_estimate_microcents`. Because the e2e DB is fresh per
job, **every** `ai_calls` row belongs to the run — no date filter. RLS
on `ai_calls` is `FORCE`d behind a non-empty `caelo.actor_kind` GUC, so
the psql query runs `SET caelo.actor_kind='system'` in the same session.

The metric surfaces three ways:

1. **Sticky PR comment** — `build-stats.ts` renders a `### Real AI cost
   (this run)` section: total `$X.XX`, call count, real tokens
   in/out/cached (sourced from `ai_calls`, **not** the loop-log token
   sum, which is cumulative-per-turn and would double-count), and a
   per-model `Model | Calls | Cost` table.
2. **Run summary + annotations** — a greppable
   `e2e-livedit-cost totalUsd=… calls=… tokensIn=… tokensOut=…
   unpriced=… sha=…` line in `$GITHUB_STEP_SUMMARY` and a
   `::notice title=e2e-livedit cost::` annotation. A future scraper can
   walk run summaries to chart spend per SHA.
3. **Durable artifact** — `ai-cost.json` uploads `if: always()` as
   `e2e-livedit-cost-<run_id>` with 90-day retention (the failure-only
   bundle would miss green runs).
4. **Budget ledger** — the same total, as one file per run on the
   `e2e-livedit-ledger` branch, feeds the weekly budget (see *When it
   runs*).

**Unpriced-call warning.** `unpricedCalls` counts rows with
`cost_estimate_microcents = 0` despite token work — the signature of
#297, where a missing `ai_pricing` row zeroed an otherwise real cost.
When it is non-zero the reported total **understates** real spend; the
PR comment renders a bold warning pointing at `/settings/ai` to add
rates, and the step emits a `::warning`.

If `ai-cost.json` is absent or the capture fell back to `{}` (a failed
psql dump), the cost section is silently omitted — older/DB-only runs
degrade gracefully. The pure parse + format logic lives in exported
`parseAiCost` / `formatCostSection` / `buildReport` functions in
`build-stats.ts`, unit-tested in `build-stats.test.ts`.

## Input-token breakdown & threshold guards (issue #432)

Every run's report attributes each scenario's input tokens instead of
printing one opaque total. The pure parsing/aggregation core lives in
`e2e-livedit/lib/metrics-core.ts` (shared by the harness and
`lib/build-stats.ts` — one parser, so the two can no longer drift; the
previous build-stats-local regex silently reported 0 loops once the log
gained a `tokensCached` field). Sources, all already emitted by the
chat-runner:

- `[chat-runner] loop` — real per-call token splits + the per-call
  `sentPrefixEstimate` (chars/4 history estimate → the per-loop `hist`
  column and the per-loop growth line).
- `[chat-runner] context-split` — one record per turn: system prompt /
  tool catalogue / per-label context blocks / per-slug skill bodies /
  history (chars/4 estimates, issue #300 part A).

The per-scenario report (`metrics-report.txt`, `metrics.json`, the
`[livedit-metrics]` console block, and the PR comment's *Input-token
breakdown* table) shows: per-call static context (system + tool
catalogue + blocks + skills), static × loops vs Σ history, history
start→end growth per loop, and per-tool result tokens. Rule of thumb
from the measured baseline: the tool catalogue dominates the static
share (~48k of ~53k est per call), so **loop count is the input-token
lever** — every extra loop re-reads the whole context (from the cache,
at a tenth of the fresh price).

**Thresholds** (`THRESHOLDS` in `lib/metrics-core.ts`) gate the homepage
scenario on **new input** (cache writes + uncached input: what a run
adds to the context and pays for in full) and **loops**. Total input is
reported but not gated: it is ~90% cache reads of context already paid
for. Ceilings re-derived 2026-10-26 from the last 13 runs: healthy new
input 102–269k / 11–25 loops; broken caching 411–439k; repair spirals
27–33 loops → 300k and 26 (rationale at the constant). **There is no
retry** (`retries: 0`): the first attempt is the verdict, so a breached
ceiling fails the run. Every attempt's violations also persist into
`scenario-metrics.jsonl`, and global-teardown emits a `::warning`
annotation per breach.

## AI-detected bugs per run (defect metric)

The pass/fail verdict cannot see the failure mode that matters most here:
**a green run in which the AI routed *around* a defect instead of failing
on it.** Caelo's internal defect channel — the `ai_bug_reports` table —
records exactly that, from three writers:

| `source` | Written by | Severity |
| --- | --- | --- |
| `ai` | the model calling the `bug_report` tool when it diagnoses a defect mid-task | model-chosen |
| `auto` | the chat-runner auto-capturing a failed tool result after auto-recovery gives up (`tool-dispatch.ts`) | `degraded` |
| `auto` | a turn-fatal provider error, with a replayed-history digest flagging `!UNANSWERED` / `!ORPHAN` tool pairs (`provider-error-report.ts`) | `blocking` |

The `Capture AI-detected bugs from ai_bug_reports` step runs
`if: always()` and dumps every row to
`apps/admin/test-results/livedit/bug-reports.json`. Same two properties as
the cost capture above: no date filter (the CI DB is fresh per job, so
every row belongs to the run) and `SET caelo.actor_kind='system'` in the
same session (RLS is `FORCE`d behind that GUC). `evidence` is dumped
untruncated so the artifact is complete; the PR comment truncates its own
copy. Rows are **not** ordered in SQL — sorting lives in
`formatBugSection` where it is unit-testable.

Locally, `global-setup.ts` wipes `ai_bug_reports` once at suite start, which
gives a repeated local run the same "every row is this run's" property CI
gets for free. It is deliberately **not** in `resetLiveditFixtures()` —
that helper runs per scenario, so wiping there would leave the run-level
report showing only the last scenario.

The metric surfaces the same three ways as cost:

1. **Sticky PR comment** — a `### Detected bugs (N)` section after the
   per-scenario results (it qualifies that verdict), with a
   `Sev | Source | Title | Tool | Blocked | Issue` table sorted blocking-first then
   by source, plus a collapsed `Bug details` block carrying
   what-happened / expected / evidence per row. Capped at 50 rows to stay
   under GitHub's 65k comment limit; when it caps it says so and points at
   the artifact.
2. **Run summary + annotations** — a greppable
   `e2e-livedit-bugs total=… blocking=… degraded=… cosmetic=… ai=… auto=…
   sha=…` line in `$GITHUB_STEP_SUMMARY`, a `::notice`, and a `::warning`
   when any `blocking` row was filed.
3. **Durable artifact** — `bug-reports.json` uploads `if: always()` as
   `e2e-livedit-bugs-<run_id>` with 90-day retention. Kept separate from
   `e2e-livedit-cost-<run_id>` so that artifact name stays stable for
   anything already scraping it.

**Gating.** Every report is either *known* or *new*. Known means it matches
an entry in `apps/admin/e2e-livedit/lib/known-bugs.ts`, which names the GitHub
issue tracking its root-cause fix. New reports are **filed, not blocking**:
the workflow sets `CAELO_E2E_FORWARD_BUGS=1`, `global-setup.ts` turns on bug
forwarding for the test install, the admin's forwarding worker sends every
report to the Caelo bug intake (epic #901) while the run goes on, and
`global-teardown.ts` waits (up to 3 min) until none is still queued. The
intake files the GitHub issue or joins an existing one for the same defect,
and the table's `Issue` column shows it (`**new** #N`, or *issue pending*
until the intake has one). The `Gate on new detected bugs` step
(`lib/bug-gate.ts`) fails the job only on **more than 5 new reports**
(`MAX_NEW_BUGS`) — that many is a broken tool surface, not a stray error —
and when the capture failed (it cannot tell "nothing found" from "could not
check"). A new report that did not reach the intake gets a `::warning`:
there is no issue for it, so file it by hand. Why not block on one: a single
tool error per run held the v0.11.0 release up for hours; it is still our
defect (CLAUDE.md §1A, §4), and its issue is where it gets owned.

When the gate fails on your PR: fix the root causes in our layer (tool
description, Zod schema, op, an earlier result that states the requirement).
A ledger entry is only for a root cause that is tracked and out of scope;
use the narrowest `match` and remove it in the PR that fixes the issue.

`{}` vs `[]` is load-bearing: the workflow writes the `{}` sentinel when
the psql capture fails, which `parseBugReports` reads as "no data" and
omits the section entirely, while a real `[]` renders an explicit
`Detected bugs (0)` zero-state. A broken capture must never be
indistinguishable from a clean run.

**Escaping.** Report text is AI- and tool-derived, so it is treated as
untrusted when spliced into the comment: inline positions (table cells,
bullets) go through `inline()`, which HTML-entity-encodes `&` then `<` then
`|` — in that order, because `&` is the escape character and the pipe's
replacement introduces a new one. Backslash escaping was tried first and
was flagged by CodeQL (`js/incomplete-sanitization`) for exactly the
second-order case entities avoid. The evidence code fence derives its width
from the body (`fenceFor`) rather than using a fixed four backticks, since
evidence legitimately contains fences and CommonMark would let one close
the block and inject free markdown into the comment.

The pure logic lives in exported `parseBugReports` / `formatBugSection` in
`build-stats.ts`, unit-tested in `build-stats.test.ts`.

Operators can browse the same rows against a live DB at `/settings/bugs`,
which also exports them as Markdown for pasting into a GitHub issue.

## Design report per run (issue #161)

Every page the design probes measure appends one line to
`apps/admin/test-results/livedit/design-report.jsonl` (truncated by
global-setup): the scenario, URL, the computed-style measurements
(colors, font sizes, loaded fonts), the deterministic violations, the
`[design-report]` warnings and the AI-judge scores. The workflow uploads it
on every run as `e2e-livedit-design-<run_id>-<attempt>` (90 days), and each
probe prints a greppable `[design-report] <scenario> <url>: N violation(s);
hierarchy=… contrast=… rhythm=… polish=…` line into the test log.

The judge is a trend metric first: read the scores across runs before
promoting any axis to a hard floor. The warnings in the same file are the
promotion candidates for the deterministic checks.

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

## Scenario isolation (what carries over between scenarios)

All scenarios share one admin process and one database (`workers: 1`),
so every piece of site state a scenario changes is visible to the
scenarios after it. Two mechanisms
reset it:

- **`resetLiveditFixtures()`** (each scenario calls it first) wipes the
  content state by SQL: chats, pages, modules, content instances,
  layout placements, non-default templates, import runs, every shared
  list, every list type but the shipped ones (`texts`, `links`, `menu`,
  `categories`, `tags`) and every page type but the site default (whose
  template list drops the wiped templates).
- **The plugin activation guard** (`_pluginActivationGuard` in
  `fixtures.ts`, automatic for every scenario importing `test` from
  `./fixtures.js`) disables, after each test — pass or fail — every
  plugin the test activated. It cannot be a SQL reset: the running
  plugin host keeps its own disabled flag, which only the admin's
  Disable action flips, so the guard drives `/settings/plugins`
  (`deactivatePluginAsOwner`). `activatePluginAsOwner` re-enables a
  plugin a previous attempt left `disabled`.

Why the guard exists: in PR #641's run the consent scenario left
`consent-manager` active. On the homepage scenario after it, the
plugin's runtime sat in every page; the AI attributed the page's
`errors-in-console` finding (really a `/favicon.ico` 404) to it and
built a cookie banner, which then covered the published page in the
vision check. On the retry the plugin's embed gate withheld the site
header (an inline SVG's `xmlns` read as a third-party host), costing
six extra loops. Scenario 1 asserts the precondition in its
`beforeEach`.

**Not reset today:** the active theme's tokens, site identity
(`site_defaults`), media and plugin-owned tables. A scenario that
depends on one of them starting from the seed has to restore it
itself (the consent scenario wipes its plugin's tables first).

## Adding a new scenario

Each scenario is a single `apps/admin/e2e-livedit/scenario-*.browser.ts`
file, listed in `scenario-paths.ts` with the repo paths it exercises (the
manifest test fails until it is — see *Scenario selection*). Use Scenario 1
as the template; the helpers in `helpers.ts` cover the common shape:

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

**Lists, list types, page types (epic #1107).** A chat's writes to them
are draft state until a Stage, so read them through
`lib/list-model.ts`: `snapshotListModel()` returns the draft view (live
rows overlaid with the newest pending snapshot) of list types, shared
lists, page types, pages with their terms, modules, layout chrome and
content-instance values, and the pure analysers (`chromeBoundLists`,
`megaMenuFacts`, `blogCategoryFacts`, `calledTool`) turn it into the facts
a spec asserts. The analysers are unit-tested in `lib/list-model.test.ts`.
`seedLayoutBlocks`, `primePostOnboarding` and `seedNewsArticles` in
`helpers.ts` seed chrome blocks, a post-onboarding theme and published
news articles for list scenarios.

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
| `transcript-failure-count == 0` after a footer-nav prompt (`scenario-ai-layout-footer`) | issue #106: the layout placement was emitted, not narrated-then-dropped — the field-schema enum gap that made a link list unrepresentable is closed. |
| A module in the layout's `footer` block declares a `list` field bound shared (`bind: "shared"`, the list fixed on the field, a shared default or a placement value `caelo:list/<id>`) to a list whose entries carry the About and Contact labels (`scenario-ai-layout-footer`) | issue #106 / §1A / epic #1107: the footer nav is ONE list field, not numbered `label1`/`label2` scalars and not anchors hardcoded into the module HTML (accepted until #1107 while the structured-set binding was unreachable for the AI, #414); footer links are a SHARED list (the alias the tool descriptions and system prompt carry). The schema's list capability is pinned deterministically in `module-fields-schema.test.ts`. |
| Mega menu: header AND footer modules are bound to ONE shared list; ≥3 top-level entries are nodes with children (the Products / Solutions / Company columns); the list's type has a node filled by a page query and the list holds such an entry; after "add Careers under Company" the same list (same id) has a Careers entry under the Company column and the follow-up turn called `patch_list_items_many` (`scenario-lists-mega-menu`) | epic #1107: the AI picking the wrong shape for a mega menu (a list per column, hardcoded news links instead of a query node, the footer copying the entries into a second list), placing the chrome per page instead of once on the layout, or maintaining a shared list by rewriting it (`upsert_lists_many`) or the module instead of an item-level patch. The scenario seeds a `news` page type with three published articles so the query has data. |
| Blog categories: a vocabulary list carries Guides / Product news / Engineering; a page type other than the site default takes that vocabulary; ≥3 pages of that type carry its terms, covering all three categories; ≥1 module lists pages by term (`term_pages` source, or a query whose defaults or placement value set `terms`) (`scenario-lists-blog-categories`) | epic #1107 / the manage-page-types skill: categories kept as plain text or a link list, articles left on the default page type, terms not assigned (`update_pages_many` / `build_page` `terms`), or category pages hand-listing their articles instead of a source. |
| Active theme is non-seed, described, and `color.primary` is chromatic — hex RGB-spread > 24 or oklch chroma > 0.03, never a seed grayscale value (`scenario-homepage`) | issue #112 / §1A: "preset-menu grayscale ship" — PR #107 run 26767610953 published a fully grayscale site because the AI satisfied the cold-start gate by minting the `shadcn-default` preset and stopping. With presets removed, the AI must compose a brand-derived `ThemeDocument` itself; this row fails if the gate criterion (origin + description) or the compose guidance regresses. Scenario-safe: the prompt names a SaaS/dev-tools brand AND states the design intent explicitly ("fitting color scheme", "nice background for the header") — run 27357551606 proved intent-free prompts let the AI clear the gate while leaving the seed grayscale primary untouched, so a chromatic primary is the only correct outcome here. |
| Composed palette carries at least two DISTINCT chromatic colors; gradient / surface-alt / web-font presence logged as `[design-report]` warnings (`scenario-homepage`) | issue #161 / epic #149: flat single-hue documents were the post-#112 ceiling — #153's palette-pair hints + DEPTH_AND_SURFACE_HINTS instruct primary + accent. The two-chromatic floor is deterministic under those primers; the richer checks (gradient, surface-alt, non-system typography) start as non-blocking warnings and get promoted to hard assertions once 10x determinism runs show they hold. |
| Served HTML carries no literal mustache tag (`{{x}}`, `{{#list}}`, an unbound `{{theme_logo_url}}`) and no `<!-- caelo:missing … -->` marker; script/style bodies excluded (`scenario-homepage`, `scenario-consistency`; `findTemplateLeaks`) | issue #161, widening #70/#71: any template the composer failed to resolve reaching a visitor — previously only `{{#`/`{{/` section markers were checked, so an unset scalar field or an unbound theme-asset slot shipped silently. |
| Rendered type hierarchy: largest `h1` ≥ 1.5× the median visible `<p>`, `h1` > median `h2` > body (`scenario-homepage`, `scenario-consistency`; `checkTypeHierarchy`) | issue #161 / #151: a flat type scale — module CSS overriding the theme's scale, or the base stylesheet's heading rules no longer applying. Medians keep one oversized CTA-band h2 or a small caption from deciding the verdict. |
| Rendered color: ≥1 distinct chromatic color actually painted (text, fills, borders, gradient stops) AND ≥1 wide block (≥90% viewport, ≥80px) whose background or gradient differs from the page background; fewer than 2 rendered chromatic colors is a `[design-report]` warning (`scenario-homepage`, `scenario-consistency`; `checkColorVariety`) | issue #161 / #153: the palette exists in the tokens (row above) but modules ignore it — the page renders in neutrals with no section rhythm. The 2-color bar starts as a warning because whether the accent is painted on THIS page is a design choice; promote after the 10x recipe. |
| When the theme declares a non-system font family: ≥1 declared family is `loaded` in `document.fonts` AND is the primary computed family of the h1 or body text (`scenario-homepage`; `checkWebFontsDelivered`) | issue #161 / #150: the font pipeline silently falling back to the system stack (woff2 not copied into the build, `@font-face` URL pointing at the admin-only preview path, module CSS hardcoding another family). Unconditional pass on system-stack themes. |
| Consistency: the first filled chromatic main-content CTA on the homepage and the pricing page match in `background-color`, `color`, `border-radius`, `font-family`, `font-weight`; the first main-content `h2` matches in family + weight, size within ±20%; the pricing page's FAQ (asked for in operator words only) is served as `data-caelo-ui="accordion"` with ≥2 `<details>` items, and clicking a question opens it with the answer visible (`scenario-consistency`, OPT-IN via `CAELO_LIVEDIT_CONSISTENCY=1`) | issue #161 / epic #149, the operator requirement verbatim: page B must match page A. The prompt does not ask for consistency (§1A), so a failure means the primitives (#152), the Design Manifest (#165) or the consistency gate (#166) stopped carrying. Chrome (nav/header/footer) is excluded — shared layout matches by construction. The FAQ half is #160's live AC: an FAQ request must compose with the vetted accordion kit (`INTERACTION_MARKUP_CONTRACT`), not hand-rolled module JS, and work for visitors. Opt-in: a second full build+publish run does not fit the per-PR job budget. |
| AI-judge rubric (hierarchy / contrast / rhythm / polish, integer 1–5) on every probed page, written to `design-report.jsonl` — NEVER asserted (`judgeDesign`) | issue #161: the taste dimension the deterministic floor cannot see. Non-blocking until the 10x recipe has measured its run-to-run variance; then promote with a floor (e.g. no axis below 3). A judge error is recorded in the artifact, not swallowed. |
| Genesis: a brief-rich prompt saves >=2 drafts with distinct directions AND non-identical skeletons; /design/genesis lists them in sandboxed iframes; one click yields exactly one `selected` row (`scenario-genesis`, OPT-IN via `CAELO_LIVEDIT_GENESIS=1`) | issue #163 / epic #149 AC #1: the design-time flow must DIVERGE (parallel freeform drafts), not emit palette-swapped clones of one skeleton, and the operator's selection is the single design contract downstream (#164 parity gate). Opt-in because a Genesis turn spawns three parallel full-page generations — nightly/on-demand cost, not per-PR (CLAUDE.md 6: live tests are gated, opt-in). |
| Onboarding: a fresh install shows the three-entry-point welcome in /edit BEFORE any input; a domain-shaped first message triggers `inspect_external_page` and lands EXACTLY ONE `import_runs` row at `status='proposed'` carrying the #193 estimate; the transcript points at /settings/import/pending (`scenario-onboarding`, OPT-IN via `CAELO_LIVEDIT_ONBOARDING=1`) | epic #186: the welcome seed (#187) silently not firing, routing text drifting out of the cold-start prompt (domain message → from-memory rebuild instead of migration), or the AI claiming the Owner-gated crawl ran (§11.A violation — the run must never move past 'proposed' without the click). |
| Migration: after ONE Approve click the crawl reaches `ready_for_review` with the sitemap-only page found (#192); the build yields ≥5 pages bound to ≥2 DISTINCT templates (#194/#195), ≥1 `.html` path 301s to its new page (#196), and the seeded typo/dead link surfaces in notes or the closing report (#197) (`scenario-migrate`, OPT-IN via `CAELO_LIVEDIT_MIGRATE=1`) | epic #186 keep-design contract end to end: one-template collapse, silent under-crawl of unlinked pages, lost URL continuity, and a migration that copies without adding value are each individually fatal to "übernehmt meine Website". The fixture site (fixtures/migrate-site.ts) is served on 127.0.0.1 with the SSRF guard exempting it via CAELO_IMPORTER_ALLOWED_HOSTS in the TEST admin only. |
| International-site: a German "übersetze die Startseite" prompt registers the locale ONLY through the gated `set_locales` path (auto-approve stands in for the click), mints the `/de/` counterpart with a localized slug, and lands translated VALUES on the variant while the source page's content bytes are untouched (`scenario-international-site`) | epic #380 #400: the AI asking the operator an implementation question ("should I create a locale first?", §1A), the translation writing through to shared module HTML (leaking German into the source page — the exact layer-confusion #397's values-model exists to prevent), or the gated tool applying without the approval flow. |

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

## When it runs

Each full run costs real money (~$5–7; measured 2026-10-20..26: $907 for
183 paid runs on 95 PR branches, 92% of the input tokens cache reads — the
money is in run count × scenario count). The `plan` job of
`.github/workflows/e2e-livedit.yml` decides what a run executes; the paid
`Real-AI live-edit scenario` job runs only what it picked.

| Trigger | What runs |
|---|---|
| PR, nothing AI-relevant changed (UI-only, docs, CI outside this suite, provisioning, tests…) | nothing — the check passes as skipped |
| PR with AI-relevant changes | the core (`homepage`) + every scenario whose paths match a changed file |
| PR that changes the harness (this suite's lib/helpers/fixtures/global setup, its Playwright config, the workflow, `docker-compose.yml`, the provider preflight) | every CI scenario |
| PR with the label `real-ai-full` | every CI scenario |
| Draft PR | nothing until it is marked ready for review |
| Release gate (`release-cut` → dispatch on `release-gate/<sha>`) | every CI scenario, no budget limit |
| Manual `gh workflow run e2e-livedit.yml --ref <branch>` | every CI scenario, no budget limit |

Main gets no run per push: a squash merge re-runs code its PR already ran.
`release-cut` runs the full suite once on the exact `main` commit it
releases and refuses to cut unless it is green. Trade-off: a regression
that only appears when two PRs combine on main surfaces at the next
release cut, not at merge time.

**Force the full suite on a PR:** add the label `real-ai-full`, then
re-run the workflow (Actions → E2E Live Edit → Re-run all jobs) or push.
Or dispatch it on the branch: `gh workflow run e2e-livedit.yml --ref
<branch>` (the dispatched run reports the same check on the branch's head
commit and ignores the budget).

### Scenario selection (`scenario-paths.ts`)

Every spec under `apps/admin/e2e-livedit/` is listed in
`apps/admin/e2e-livedit/scenario-paths.ts` with the repo paths it
exercises (`Bun.Glob` patterns). `lib/plan.ts` maps the PR's changed files
(GitHub's PR files API, renames counted on both names) onto it:

- `AI_RELEVANT_PATHS` minus tests (`NON_RUNTIME_PATHS`) minus
  `NO_REAL_AI_COVERAGE` decides whether anything runs. AI-relevant: the
  whole AI layer (`packages/admin-core/src/ai/**`: chat-runner, system
  prompt, providers, every tool), the ops and rendering the suite drives,
  `packages/shared`, the Query API, migrations (skills are seeded there),
  every plugin and the plugin runtime, the static generator, the chat UI
  and `/edit`, `apps/admin/src/lib/server`, the lockfile and package
  manifests.
- `NO_REAL_AI_COVERAGE` lists AI-relevant-looking files no CI scenario
  reaches (users/roles, step-up, platform updates, domains, gateway,
  email, redirects, theme import, site migration — the last only covered
  by the opt-in migrate/onboarding scenarios). A change there runs
  nothing, honestly: no scenario would exercise it.
- **The core is `homepage`.** It is the one scenario that drives the whole
  loop on every AI surface at once — cold start, theme compose, page and
  module build through the full tool catalogue and the system prompt, AI
  Stage, quality audit, human Publish, re-edit, vision verdict — and it
  carries the token/loop ceilings. Every tool definition rides in every
  request it makes, so a catalogue or prompt regression anywhere shows up
  there first. It runs on every PR with an AI-relevant change.
- Opt-in scenarios (`optIn`: consistency, genesis, onboarding, migrate,
  google-pictbook) are listed for documentation but never selected — CI
  does not set their flags, so they would only skip themselves.

`lib/plan.test.ts` fails when a tracked file under the AI-relevant roots is
matched by no CI scenario and is not in `NO_REAL_AI_COVERAGE`, when a spec
file is missing from the manifest, or when a glob matches no file. **A new
AI area must be mapped to the scenario that exercises it** (or declared
uncovered on purpose) — it can never be skipped silently. Adding a
scenario: add its entry to `SCENARIOS` with the paths it covers.

To run a subset locally: `CAELO_LIVEDIT_SCENARIOS=scenario-consent.browser.ts,scenario-homepage.browser.ts bun run e2e-livedit`
(comma-separated spec file names; empty runs everything;
`playwright.livedit.config.ts` rejects anything that is not a spec name).

### Follow-up pushes: keep what is green

After the bug gate passed, each run records the scenarios it left green
as `{id, key}` (artifact `e2e-livedit-scenario-greens-<run_id>-<attempt>`,
30 days) — also when another scenario failed, so the next push re-runs
only what was red. A scenario's **key** is a SHA-256 over what the PR
changed in the files it covers: each changed file under its paths (for
the core: each changed AI-relevant file), its own spec and the harness,
with its blob id in the tested tree. The next push's plan reads the greens
of the PR's last 15 runs; a selected scenario whose key is unchanged keeps
its result, everything else runs. If every selected scenario is kept, the
paid job is skipped (passing).

Main moving on does not change a key — only the PR's own changes do. That
is the same trade-off as for main itself (combinations are caught at the
release gate, which always runs everything); keying on the whole tested
tree would re-run the core on nearly every push, because main changes AI
files several times a day. Nothing is recorded when the bug gate failed
(new bugs cannot be pinned to one scenario), so the next push re-runs the
whole selection. The `e2e-livedit-green-tree-<tree>` artifact that
`release-cut` reuses is written only by a run that executed **every** CI
scenario and passed.

### Cheap checks first, no cancelled paid runs

The plan job waits (up to 65 min) until `Lockfile freshness`, `Lint,
Typecheck, Migrate, Test, License` and `Admin production image — boot
smoke` of `ci.yml` finished on the PR's head commit (the newest attempt of
each counts). If one is red, the paid job **fails** at once with "CI is red
on this commit" instead of running — a skip would pass the required check
and a later CI re-run to green would leave the suite unrun. Re-run this
workflow (Re-run all jobs) after fixing CI. `workflow_run` was not used:
it reports no check on the PR, and the required check name must stay.

A paid run in flight is never cancelled by a new push — a cancelled run
is already paid for (15 were cancelled on 2026-10-26 alone). The paid job
has job-level `concurrency` with `cancel-in-progress: false`: one runs per
PR, the newest waiting one queues, and GitHub drops an older pending one.
A plan that finds the PR moved on after the CI wait skips, and a paid job
that starts for a commit that is no longer the PR head cancels its own run
before any paid step.

### Weekly budget

Every run that reached the provider writes one file to the
`e2e-livedit-ledger` branch: `runs/<UTC time>_<run_id>-<attempt>_<microcents>.json`
(the run's `ai-cost.json`; 1 USD = 1e8 microcents; entries older than 9
days are pruned). The plan job sums the trailing 7 days from one
directory listing (`lib/budget.ts`) — the `e2e-livedit-cost-<run_id>`
artifacts stay the durable 90-day record, but summing them takes one zip
download per run, more than a job's API budget. When the sum reaches the
repo variable `E2E_LIVEDIT_WEEKLY_BUDGET_USD` (default **$250**), PR runs
skip with a passing, annotated check and the sticky PR comment says
"Real-AI weekly budget used: $X of $Y — runs on release gate / manual
dispatch only". The release gate and a manual dispatch always run (and
count). Every run's PR comment shows the spend-vs-budget line.

The sticky PR comment is one comment per PR (marker
`<!-- e2e-livedit-sticky -->`), edited by every run
(`lib/sticky-comment.sh`).

### CI secret gate

The plan job's first step reads `secrets.ANTHROPIC_API_KEY_E2E` into an
env var. Without it (a fork, a fresh clone of the repo) the plan says
`skip`: the paid job is SKIPPED, so the check passes instead of failing on
a config gap. Once the secret is configured every PR follows the rules
above without code changes.

A plan job that fails or cannot decide (an API error, a broken selection)
does not skip: the paid job runs and its first step fails with the reason,
because a skipped required check would pass.

### Provider preflight (fail fast)

The first paid step, `AI provider preflight (fail fast)`, runs
`scripts/ai-provider-preflight.ts`: one `max_tokens: 1` call on the
cheapest catalog model (the Anthropic `fast` slot in
`model-catalog.json`) with the CI key, before install, compose and build.

- **Usage/spending limit or credit used up** → the job fails within
  seconds with **"AI provider quota exhausted"** (step summary, `::error::`
  annotation, PR comment). No scenario runs and no bug report is filed.
  Raise the limit (or wait for the date the provider names) and re-run.
- **Refused otherwise** (invalid key, permission, unknown model) → fails
  at once with the provider's message.
- **Overloaded / 5xx / 429 / network** → retried after 5 s, 15 s and
  30 s, then the job fails with "AI provider unavailable".

It lives inside the paid job on purpose: a failing gate job would skip
the suite job, and a skipped required check counts as passing. The key is
passed through env only and redacted from any message.

**Account refusals are not bugs — in the product too.** When the provider
refuses a chat turn for an account reason (usage limit, credit, billing,
invalid or revoked key; Anthropic's 400 "You have reached your specified
API usage limits", OpenAI's `insufficient_quota`, Google's billing
`RESOURCE_EXHAUSTED`, 401/403 key errors), the chat-runner shows the
operator a brand-free notice ("The AI can't answer right now: the usage,
spending or billing limit of the configured AI provider account is used
up… An Owner has to raise the limit… Settings → AI") and files **no**
`ai_bug_reports` row, so the bug intake opens no issue for it
(`packages/admin-core/src/ai/provider-account-error.ts`, classified from
the AI SDK's `APICallError`). The same holds for an image provider's
refusal in `generate_image` / `edit_image`.

Inside the scenarios, `sendChatPromptAndWait` checks after every turn for
`AI turn failed: provider error` reports and for those account notices
(top-level chats only), and fails right there with the message
(`lib/turn-failure.ts`). A turn that dies mid-run therefore no longer
shows up as a downstream "module is null" or a 6-minute Stage timeout.

## Suggested next scenarios (v0.13.1+)

- **Scenario 3** — footer copyright edit + Stage/Publish round-trip
  with substring checks on the production HTML.

It is tracked on the v0.13.1 follow-up roadmap issue (opened
when this PR is opened, per AC #19 in `.workflow-plan.md`).
