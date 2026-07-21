// SPDX-License-Identifier: MPL-2.0

/**
 * Playwright + DB + log helpers shared by every e2e-livedit scenario
 * (issue #47). All assertions are deterministic; the only AI call is
 * the closing vision verdict in `verifyPublishedPageWithVision`,
 * which lives in `./lib/vision-verdict.ts` for unit-testability.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { Page, Response } from "@playwright/test";
import { expect } from "@playwright/test";
import { ADMIN_LOG_PATH } from "./global-setup.js";
import { fetchVisionVerdict, type VisionVerdict } from "./lib/vision-verdict.js";

// Re-export for spec convenience (parallel to apps/admin/e2e/helpers.ts).
export const DEV_OWNER_EMAIL = "dev-owner@example.com";
export const DEV_OWNER_PASSWORD = "dev owner password";

/**
 * Run a small Bun subprocess so specs (Node-side Playwright) can hit
 * Postgres via bun:SQL — same pattern as the existing e2e helpers.
 * Pass user-supplied values through `extraEnv`; reading them via
 * `process.env.X` inside the script avoids template-injection issues
 * with Bun's tagged-template SQL parser.
 */
function runBunInline(script: string, extraEnv: Record<string, string> = {}): string {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  const result = spawnSync("bun", ["-e", script], { env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`bun -e failed (status ${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/**
 * Truncate the fixtures the real-AI scenarios create so Playwright's
 * `retries: 1` doesn't trip over orphan rows from a prior attempt.
 *
 * Deletes (system context, in one tx):
 *   - chat_entity_locks  — orphan-lock test would see stale rows
 *   - chat_tool_results  — child of chat_messages
 *   - chat_messages      — assistant turn count would over-report
 *   - chat_sessions      — the per-page chat the AI ran
 *   - pages              — CASCADE drops page_modules + page_module_content
 *   - chat_branch_publish_marks (FK to chat_sessions)
 *
 * Safe because the e2e seed (apps/admin/e2e/_seed.ts) does not insert
 * any of these — only users/roles/ai_providers. Each test starts from
 * a known empty content/chat state.
 */
export function resetLiveditFixtures(): void {
  runBunInline(`
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM chat_entity_locks\`;
      await tx\`DELETE FROM chat_tool_results\`;
      await tx\`DELETE FROM chat_branch_publish_marks\`;
      await tx\`DELETE FROM chat_messages\`;
      await tx\`DELETE FROM chat_sessions\`;
      await tx\`DELETE FROM pages\`;
      // PR #61 added content_instances + content_instance_snapshots.
      // Without wiping them, the next scenario's AI sees the prior
      // scenario's leftovers in the \`## Modules\` + \`## Content
      // Library\` system-prompt blocks and may decide to reuse them
      // instead of authoring fresh — which leaves the assertion's
      // "the AI created module X" lookup finding nothing new. Worse:
      // a prior scenario that ran chat.merge_to_main (publish) clears
      // \`chat_branch_id\` on its modules, so a "wipe branched only"
      // pattern misses them. Migrations seed ZERO modules /
      // content_instances (verified: no \`INSERT INTO modules\` in
      // cms_admin migrations), so wiping all is safe and self-seeded
      // scenarios re-create what they need after this reset.
      // Order: snapshots → content_instances → snapshots → modules
      // (FK chain — modules is referenced by content_instances).
      await tx\`DELETE FROM content_instance_snapshots\`;
      await tx\`DELETE FROM content_instances\`;
      await tx\`DELETE FROM module_snapshots\`;
      // layout_modules.module_id FK has no ON DELETE clause (defaults
      // to NO ACTION) — wipe layout-module placements before modules
      // so the modules DELETE doesn't fail. layout_modules has no
      // migration-seeded rows; scenarios that need chrome modules
      // re-seed after this reset.
      await tx\`DELETE FROM layout_modules\`;
      await tx\`DELETE FROM modules\`;
      // Templates + import state persist across scenarios if not wiped. A
      // migrate/compose scenario running AFTER template-creating scenarios
      // (genesis, homepage) fed compose_from_import the LEFTOVER templates,
      // ballooning the migrate turn's context past the model's 1M window
      // (a failed call → dangling tool calls → 0 pages). Wipe them, but
      // PRESERVE the migration-seeded default template + layout that
      // site_defaults references (0023). Order: children before parents;
      // pages + chat_sessions (the other template referrers) are already
      // wiped above.
      await tx\`DELETE FROM import_run_events\`;
      await tx\`DELETE FROM import_pages\`;
      await tx\`DELETE FROM import_runs\`;
      // NOT IN (subquery) inline — preserve the migration-seeded default
      // template that site_defaults references (0023); wipe the rest.
      const keep = "SELECT default_template_id FROM site_defaults WHERE default_template_id IS NOT NULL";
      await tx.unsafe(\`DELETE FROM template_snapshots WHERE template_id NOT IN (\${keep})\`);
      await tx.unsafe(\`DELETE FROM template_pending_actions WHERE template_id NOT IN (\${keep})\`);
      await tx.unsafe(\`DELETE FROM template_blocks WHERE template_id NOT IN (\${keep})\`);
      await tx.unsafe(\`DELETE FROM templates WHERE id NOT IN (\${keep})\`);
      // Login bucket gets consumed by every loginAsDevOwner() call;
      // global-setup only clears it once at suite start, so after 5+
      // tests the rate limiter starts rejecting and loginAsDevOwner's
      // waitForURL times out at the /login page. Clear it per-reset.
      await tx\`DELETE FROM rate_limit_buckets WHERE key LIKE 'login:%'\`;
    });
    await sql.end();
  `);
}

/**
 * v0.12.0 — seed a minimal layout/template/page scaffold so the
 * AI-driven scenarios have a target to add modules to.
 *
 * `resetLiveditFixtures` deletes `pages` but leaves layouts +
 * templates intact, so we only re-create what's missing. Returns
 * the seeded page id so the spec can reference it in the AI prompt.
 *
 * Uses the `homepage` slug + `home` template kind so the AI's
 * `## Pages` block surfaces the page under `### kind=home` and the
 * AI knows which template to keep using on follow-up adds.
 */
export function seedMinimalSite(): { pageId: string; templateId: string } {
  const out = runBunInline(`
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    let result;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");

      // Layout: reuse the existing site-default if present; mint one
      // otherwise. layouts.html carries a single <caelo-layout-content>
      // marker so the rendered page slots its template chrome inside.
      const existingLayout = await tx\`
        SELECT id::text AS id FROM layouts
        WHERE slug = 'site-default' AND deleted_at IS NULL LIMIT 1
      \`;
      let layoutId;
      if (existingLayout[0]) {
        layoutId = existingLayout[0].id;
      } else {
        const lay = await tx\`
          INSERT INTO layouts (slug, display_name, html, css)
          VALUES ('site-default', 'Site default',
                  '<!doctype html><html><head><title>{{title}}</title></head><body><caelo-layout-content></caelo-layout-content></body></html>',
                  '')
          RETURNING id::text AS id
        \`;
        layoutId = lay[0].id;
      }

      // Template: home-template with a single 'content' block.
      const existingTpl = await tx\`
        SELECT id::text AS id FROM templates
        WHERE slug = 'home-template' AND deleted_at IS NULL LIMIT 1
      \`;
      let templateId;
      if (existingTpl[0]) {
        templateId = existingTpl[0].id;
      } else {
        const tpl = await tx\`
          INSERT INTO templates (slug, display_name, kind, html, css, layout_id)
          VALUES ('home-template', 'Home template', 'home',
                  '<main><caelo-slot name="content">_</caelo-slot></main>',
                  '', \${layoutId}::uuid)
          RETURNING id::text AS id
        \`;
        templateId = tpl[0].id;
        await tx\`
          INSERT INTO template_blocks (template_id, name, display_name, position)
          VALUES (\${templateId}::uuid, 'content', 'Content', 0)
          ON CONFLICT (template_id, name) DO NOTHING
        \`;
      }

      // Page: 'home' (matches the seed-dev-owner.ts convention +
      // every scenario helper that queries WHERE slug='home').
      //
      // Atomic upsert keyed by the same expression-based unique index
      // (pages_slug_locale_branch_uidx) the DB enforces. Without the
      // atomic upsert, a prior scenario's still-running chat-runner
      // can sneak an INSERT between our DELETE and our INSERT under
      // READ COMMITTED isolation (each statement takes a fresh
      // snapshot, so the unique constraint on the second statement
      // fires even though the first deleted the conflicting row).
      // Symptom: \`pages_slug_locale_branch_uidx\` violation that
      // tripped half the AI scenarios in the full-suite run at
      // retries=1. ON CONFLICT DO UPDATE makes seedMinimalSite
      // idempotent across the race.
      const pg = await tx\`
        INSERT INTO pages (slug, locale, name, title, template_id, status)
        VALUES ('home', 'en', 'Home', 'Home', \${templateId}::uuid, 'draft')
        ON CONFLICT (slug, locale, COALESCE(chat_branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
          WHERE deleted_at IS NULL
          DO UPDATE SET
            name = EXCLUDED.name,
            title = EXCLUDED.title,
            template_id = EXCLUDED.template_id,
            status = EXCLUDED.status
        RETURNING id::text AS id
      \`;
      const pageId = pg[0].id;
      result = { pageId, templateId };
    });
    console.log(JSON.stringify(result));
    await sql.end();
  `);
  return JSON.parse(out) as { pageId: string; templateId: string };
}

/**
 * Logs into the admin as dev-owner via the form on `/login`. Leaves
 * the page on whichever route the post-login redirect lands on.
 */
export async function loginAsDevOwner(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(DEV_OWNER_EMAIL);
  await page.getByLabel(/password/i).fill(DEV_OWNER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
}

/**
 * Wait for the chat composer's status to be `idle` — set by the
 * `data-turn-state` attribute on `[data-testid="chat-turn-status"]`
 * in ChatPanel.svelte. After a send() click the attribute flips to
 * `streaming`; when the SSE turn finishes (the streaming $state goes
 * false), it flips back to `idle`.
 *
 * 480s default: a multi-tool homepage build PLUS the #155 self-review
 * rounds (each a browser-mediated screenshot + a model turn). The
 * timeout guards hangs, not the design loop — same rationale as the
 * 600s per-test budget in playwright.livedit.config.ts.
 */
export async function waitForChatTurnIdle(page: Page, timeoutMs = 480_000): Promise<void> {
  // The status element is `hidden`; assert against the attribute, not
  // visibility.
  await expect(page.getByTestId("chat-turn-status")).toHaveAttribute("data-turn-state", "idle", {
    timeout: timeoutMs,
  });
}

/**
 * Send a prompt into the chat composer and wait for the SSE turn to
 * complete (the `data-turn-state` flips streaming → idle).
 */
export async function sendChatPromptAndWait(
  page: Page,
  prompt: string,
  // Turn-completion budget. Default 480s fits a homepage build + self-review.
  // The heaviest flows (Genesis' 3 parallel draft subagents, a migration's
  // per-type rebuild fan-out) legitimately run longer — they pass a larger
  // budget. The timeout guards hangs, not slow-but-progressing turns.
  timeoutMs = 480_000,
): Promise<void> {
  // Wait for the composer to be ready first (rules out a still-streaming
  // prior turn from previous scenario state).
  await waitForChatTurnIdle(page);
  await page.getByTestId("chat-composer").fill(prompt);
  // Wait for the streaming state to actually flip before believing
  // the turn has started; otherwise a fast first-event arrival can
  // make us think the turn is already idle.
  await Promise.all([
    expect(page.getByTestId("chat-turn-status")).toHaveAttribute("data-turn-state", "streaming", {
      timeout: 30_000,
    }),
    page.getByTestId("chat-send").click(),
  ]);
  await waitForChatTurnIdle(page, timeoutMs);
}

/** Capture the URL of the most recent chat SSE stream this page initiated. */
export interface ChatSessionTracker {
  /** Last sessionId observed in a `/content/chat/<id>/stream` POST. */
  readonly currentSessionId: () => string | null;
}

export function attachChatSessionTracker(page: Page): ChatSessionTracker {
  let current: string | null = null;
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    const m = req.url().match(/\/content\/chat\/([^/]+)\/stream(\?|$)/);
    if (m) current = m[1] ?? null;
  });
  return { currentSessionId: () => current };
}

/**
 * Collect browser `console.error` + uncaught `pageerror` events for the
 * scenario's lifetime. The `assertNoBrowserConsoleErrors` helper drains
 * the buffer at scenario teardown and fails the test with quoted
 * messages if any landed.
 *
 * Catches the regression class step 13 surfaced on PR #61: a Svelte
 * route can compile fine on the server, ship to the browser, and then
 * fail at runtime because of v-flag-strict regex parsing, web-component
 * upgrade errors, or hydration mismatches — none of which show up in
 * `bun run check` or in admin.log. The scenario only catches them if
 * someone watches DevTools, which CI doesn't.
 *
 * Default ignore list — extend with caution. Each entry must:
 *   1. be a string the test author would otherwise have to recognise
 *      and dismiss in DevTools on every run,
 *   2. come from third-party code OR be a known artifact of the
 *      Playwright-vs-Svelte-vs-bun lifecycle (teardown / hot-reload /
 *      navigation aborts), AND
 *   3. carry a comment naming the upstream cause + a follow-up issue
 *      or remediation path so the entry can be removed later.
 *
 * Resist the urge to expand this. Every entry hides a class of error
 * that future regressions can use as a hiding place.
 */
const DEFAULT_CONSOLE_ERROR_IGNORE: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    // bits-ui `use-arrow-navigation.js`: `candidate.hasAttribute(...)`
    // crashes when `candidate` is a Comment node, which Svelte 5
    // emits as a fragment-end marker. Upstream issue: third-party.
    // Trips on every page with a Combobox / Menu / Select. Tracked
    // for follow-up — remove this entry once bits-ui ships the fix.
    pattern: /TypeError: \w+\.hasAttribute is not a function/,
    reason: "bits-ui arrow-navigation hits a Comment node",
  },
  {
    // Inflight fetch (SSE stream, prefetch, image) aborts on page
    // navigation / test teardown. Browser surfaces as console.error
    // before unloading. Not actionable — no bug surface beneath it.
    pattern: /TypeError: Failed to fetch/,
    reason: "fetch aborted by page navigation / test teardown",
  },
  {
    // Genesis draft previews render in a `sandbox`ed <iframe srcdoc> that
    // deliberately omits `allow-scripts` (drafts are untrusted AI HTML).
    // When a draft carries a <script>, the browser refuses to run it and
    // logs this console.error — the sandbox doing exactly its job, which
    // is a security guarantee we WANT, not a regression. It is not
    // something a real operator can act on, so it must not fail the guard.
    pattern: /Blocked script execution in .* the document'?s frame is sandboxed/,
    reason: "genesis draft-preview sandbox blocks untrusted script (expected)",
  },
];

export interface BrowserConsoleErrorTracker {
  readonly drain: () => readonly string[];
}

export function attachBrowserConsoleErrorTracker(
  page: Page,
  options: { ignore?: (message: string) => boolean } = {},
): BrowserConsoleErrorTracker {
  const errors: string[] = [];
  const customIgnore = options.ignore ?? (() => false);
  const shouldIgnore = (text: string): boolean => {
    if (customIgnore(text)) return true;
    return DEFAULT_CONSOLE_ERROR_IGNORE.some((e) => e.pattern.test(text));
  };
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (shouldIgnore(text)) return;
    errors.push(`[console.error] ${text}`);
  });
  page.on("pageerror", (err) => {
    const text = `${err.name}: ${err.message}`;
    if (shouldIgnore(text)) return;
    errors.push(`[pageerror] ${text}`);
  });
  return { drain: () => errors.slice() };
}

export function assertNoBrowserConsoleErrors(tracker: BrowserConsoleErrorTracker): void {
  const errors = tracker.drain();
  if (errors.length === 0) return;
  const quoted = errors.map((e) => `  - ${e.slice(0, 300)}`).join("\n");
  throw new Error(
    `assertNoBrowserConsoleErrors: ${errors.length} browser-side error(s) during this scenario. ` +
      `Each one is something a user would see as a red entry in DevTools.\n${quoted}`,
  );
}

/**
 * Click the Stage modal trigger + confirm; resolves when the
 * `?/stageAndDeployStaging` action returns. The action awaits
 * `chat.merge_to_main` + `deploy.trigger` synchronously, so the HTTP
 * response landing is the "staging build is on disk" signal —
 * subsequent `fetch(getStagingUrl())` sees the new content.
 *
 * We deliberately do NOT parse the response body. Reading the
 * staging URL via `getStagingUrl()` (env-based) keeps the helper
 * free of SvelteKit/devalue wire-format coupling.
 */
export async function awaitStageComplete(page: Page): Promise<void> {
  const responsePromise = page.waitForResponse(
    (r: Response) => r.url().includes("?/stageAndDeployStaging") && r.request().method() === "POST",
    // 360s since #155 — see waitForChatTurnIdle's rationale (hang guard,
    // not a race against legitimately longer turns/builds on a busy runner).
    { timeout: 360_000 },
  );
  await page.getByTestId("stage-btn").click();
  await page.getByTestId("stage-submit-btn").click();
  const res = await responsePromise;
  if (res.status() < 200 || res.status() >= 300) {
    throw new Error(
      `awaitStageComplete: stageAndDeployStaging returned HTTP ${res.status()}. Response: ${(await res.text()).slice(0, 500)}`,
    );
  }
}

export async function awaitPublishComplete(page: Page): Promise<void> {
  const responsePromise = page.waitForResponse(
    (r: Response) => r.url().includes("?/promoteToProduction") && r.request().method() === "POST",
    // 360s since #155 — see waitForChatTurnIdle's rationale (hang guard,
    // not a race against legitimately longer turns/builds on a busy runner).
    { timeout: 360_000 },
  );
  // Both `promote-btn` (chat-not-published case) and `promote-only-btn`
  // (chat-already-published case) map to the same form action. Click
  // whichever is in the DOM.
  const promote = page.getByTestId("promote-btn").or(page.getByTestId("promote-only-btn")).first();
  await promote.click();
  const res = await responsePromise;
  if (res.status() < 200 || res.status() >= 300) {
    throw new Error(
      `awaitPublishComplete: promoteToProduction returned HTTP ${res.status()}. Response: ${(await res.text()).slice(0, 500)}`,
    );
  }
}

/**
 * Assert `chat_entity_locks` has no rows for this chat session.
 * Guards against the v0.10.19 regression class where the AI's
 * tool-call left a row in `chat_entity_locks` that should have been
 * released at Stage time.
 */
export function assertNoOrphanLocks(chatSessionId: string): void {
  const out = runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = await tx\`
        SELECT count(*)::int AS n FROM chat_entity_locks
        WHERE chat_session_id = \${process.env.CHAT_SESSION_ID}::uuid
      \`;
      process.stdout.write(String(rows[0]?.n ?? 0));
    });
    await sql.end();
    `,
    { CHAT_SESSION_ID: chatSessionId },
  );
  const n = Number.parseInt(out.trim(), 10);
  if (n !== 0) {
    throw new Error(
      `assertNoOrphanLocks: chat_entity_locks has ${n} rows for chat session ${chatSessionId} after Stage/Publish (v0.10.19 regression class).`,
    );
  }
}

/**
 * Grep the captured admin stderr for the two diag-log strings the
 * chat-runner emits when something went wrong:
 *
 *   - `[chat-runner] empty-response`  (v0.10.17 regression class)
 *   - `[chat-runner] passive-response-diag`  (v0.10.21 regression class)
 *
 * Either appearance fails the scenario with a quoted snippet of the
 * matching line so the operator can act on it.
 */
const DIAG_PATTERNS = [
  /\[chat-runner\] empty-response\b.*/,
  /\[chat-runner\] passive-response-diag\b.*/,
] as const;

export function assertNoChatRunnerDiagWarnings(): void {
  if (!existsSync(ADMIN_LOG_PATH)) {
    throw new Error(
      `assertNoChatRunnerDiagWarnings: ${ADMIN_LOG_PATH} not found — global-setup did not capture admin stderr.`,
    );
  }
  const log = readFileSync(ADMIN_LOG_PATH, "utf8");
  for (const pattern of DIAG_PATTERNS) {
    const m = log.match(pattern);
    if (m) {
      throw new Error(
        `assertNoChatRunnerDiagWarnings: regression-guard pattern hit. Matched: "${m[0].slice(0, 200)}". See ${ADMIN_LOG_PATH} for the full context.`,
      );
    }
  }
}

/**
 * Catch backend errors that escaped to admin stderr — the broader sweep
 * `assertNoChatRunnerDiagWarnings` was missing. The step 13 e2e walk on
 * PR #61 surfaced 3+ `chat_messages_chat_session_id_fkey` violations
 * logged by the bun:SQL driver when the chat-runner raced session
 * deletion; those were red `Failed query` blocks in admin.log that
 * neither bun-test nor Playwright noticed.
 *
 * Patterns matched (line-anchored to avoid false-positives on tool
 * results that quote the strings):
 *   - `ERR_POSTGRES_SERVER_ERROR`  — any Postgres-driver server error
 *   - `[chat-runner] failed to persist` — runner gave up on a write
 *   - `[chat-runner] max_loops cap hit` — loop terminated abnormally
 *
 * The Postgres pattern can also be tripped by intentional
 * validator-level rejections (RLS denials, FK checks on Tier-2 ops),
 * so the message includes the matched line so the reader can decide
 * whether to allowlist or fix.
 */
const BACKEND_ERROR_PATTERNS = [
  /^.*ERR_POSTGRES_SERVER_ERROR.*$/m,
  /^.*\[chat-runner\] failed to persist.*$/m,
  /^.*\[chat-runner\] max_loops cap hit.*$/m,
] as const;

/**
 * Snapshot the current admin.log size so a later
 * `assertNoBackendErrors` reads only what was written during this
 * scenario. Without this, scenario 4 would fail on scenario 2's
 * errors and obscure which run actually regressed.
 */
export interface BackendLogTracker {
  readonly startOffset: number;
}

export function snapshotBackendLogOffset(): BackendLogTracker {
  const startOffset = existsSync(ADMIN_LOG_PATH) ? statSync(ADMIN_LOG_PATH).size : 0;
  return { startOffset };
}

export function assertNoBackendErrors(
  tracker: BackendLogTracker,
  options: { ignore?: RegExp[] } = {},
): void {
  if (!existsSync(ADMIN_LOG_PATH)) {
    throw new Error(
      `assertNoBackendErrors: ${ADMIN_LOG_PATH} not found — global-setup did not capture admin stderr.`,
    );
  }
  // Read the full file (Node's `start` arg on readFileSync isn't
  // public) and slice from the recorded offset. admin.log stays small
  // (~few hundred KB per scenario), so this is fine.
  const fullLog = readFileSync(ADMIN_LOG_PATH, "utf8");
  // Byte vs. char offset: bun's admin.log is plain ASCII for log
  // headers; we use Buffer.byteLength of the prefix to keep the slice
  // honest when stack traces include multibyte chars.
  const buf = Buffer.from(fullLog, "utf8");
  const sliceBuf = buf.subarray(Math.min(tracker.startOffset, buf.length));
  const log = sliceBuf.toString("utf8");
  const ignore = options.ignore ?? [];
  const hits: string[] = [];
  for (const pattern of BACKEND_ERROR_PATTERNS) {
    const m = log.match(pattern);
    if (!m) continue;
    if (ignore.some((re) => re.test(m[0]))) continue;
    hits.push(m[0].slice(0, 400));
  }
  if (hits.length === 0) return;
  throw new Error(
    `assertNoBackendErrors: ${hits.length} backend error line(s) in admin.log (since byte ${tracker.startOffset}):\n` +
      hits.map((h) => `  - ${h}`).join("\n") +
      `\nSee ${ADMIN_LOG_PATH} for the full context.`,
  );
}

/**
 * `getStagingUrl()` / `getProductionUrl()` resolve the URLs the
 * scenario fetches after Stage / Publish. The Stage action's response
 * already includes `previewUrl`, but the production URL is a stack
 * config (no form-action returns it), so we read it from env.
 */
export function getStagingUrl(): string {
  return process.env.CAELO_STAGING_BASE_URL ?? "http://localhost:8081";
}

export function getProductionUrl(): string {
  return process.env.CAELO_PRODUCTION_BASE_URL ?? "http://localhost:8082";
}

/**
 * Take a full-page screenshot of the published page and ask Anthropic
 * vision whether it renders correctly. Returns the parsed verdict so
 * the scenario can call `expect(verdict.ok).toBe(true)` and surface
 * `verdict.reason` on failure.
 *
 * The HTTP / parsing / retry logic lives in `./lib/vision-verdict.ts`
 * (Playwright-free, unit-tested).
 */
export async function verifyPublishedPageWithVision(page: Page): Promise<VisionVerdict> {
  const apiKey = process.env.ANTHROPIC_API_KEY_E2E;
  if (!apiKey) {
    throw new Error(
      "verifyPublishedPageWithVision: ANTHROPIC_API_KEY_E2E is unset (global-setup should have caught this).",
    );
  }
  const buffer = await page.screenshot({ fullPage: true, type: "png" });
  return fetchVisionVerdict({
    apiKey,
    screenshotBase64: buffer.toString("base64"),
    mediaType: "image/png",
  });
}
