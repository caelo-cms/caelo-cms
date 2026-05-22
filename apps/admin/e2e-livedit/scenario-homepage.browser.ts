// SPDX-License-Identifier: MPL-2.0

/**
 * Scenario 1 (v0.13.0) — Create a homepage from scratch via real AI,
 * then re-edit just the hero headline.
 *
 * Validates the full chat → Stage → Publish → re-edit loop against
 * the live Anthropic API (Sonnet 4.6, temperature=0). Every mid-flow
 * assertion is deterministic (DOM via getByRole/locator, DB via
 * bun:SQL, admin-stderr via captured admin.log); the only AI call in
 * the verification path is the closing vision verdict on the published
 * production URL.
 *
 * Coverage map (`.workflow-plan.md` §8 Tier 3 + §7 AC):
 *   • AC #2 — homepage create + re-edit preservation
 *   • AC #4, #5 — Playwright drives everything, no mid-flow LLM
 *   • AC #6 — closing vision verdict
 *   • AC #7 — orphan-lock + chat-runner-diag regression guards
 *   • AC #11 — retries=2 (config-level)
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import {
  assertNoChatRunnerDiagWarnings,
  assertNoOrphanLocks,
  attachChatSessionTracker,
  awaitPublishComplete,
  awaitStageComplete,
  getProductionUrl,
  loginAsDevOwner,
  sendChatPromptAndWait,
  verifyPublishedPageWithVision,
} from "./helpers.js";

const HOMEPAGE_PROMPT =
  "Create a homepage for an AI-first CMS called Caelo. Include a hero section with a headline, " +
  "a 3-column feature grid below the hero with three features about branched edits, plugin sandbox, " +
  "and snapshot revert, and a footer module with copyright text mentioning Caelo and MPL 2.0.";

const HERO_REEDIT_PROMPT = "Change the hero headline.";

interface PageModuleSnapshot {
  readonly pageId: string;
  readonly title: string;
  readonly slug: string;
  readonly placements: ReadonlyArray<{
    blockName: string;
    position: number;
    moduleSlug: string;
    contentUpdatedAt: string | null;
  }>;
  readonly footerContentText: string;
}

/**
 * Find the most-recently-touched page (created or content-updated)
 * and snapshot its placements + content rows. Returns null when no
 * page has been touched since `sinceTimestamp` — surfaces "AI emitted
 * no add_page tool call" loudly rather than asserting against stale
 * seed pages.
 */
function snapshotMostRecentPage(sinceTimestamp: string): PageModuleSnapshot | null {
  const raw = spawnSync(
    "bun",
    [
      "-e",
      `
        import { SQL } from "bun";
        const sql = new SQL(process.env.ADMIN_DATABASE_URL);
        const out = {};
        await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
          const pages = await tx\`
            SELECT
              p.id::text AS "pageId",
              p.title,
              p.slug,
              GREATEST(p.created_at, p.updated_at) AS "lastTouched"
            FROM pages p
            WHERE p.deleted_at IS NULL
              AND GREATEST(p.created_at, p.updated_at) >= \${process.env.SINCE}::timestamptz
            ORDER BY GREATEST(p.created_at, p.updated_at) DESC
            LIMIT 1
          \`;
          if (pages.length === 0) {
            process.stdout.write("null");
            return;
          }
          const pg = pages[0];
          const placements = await tx\`
            SELECT
              pm.block_name      AS "blockName",
              pm.position        AS position,
              m.slug             AS "moduleSlug",
              pmc.updated_at::text AS "contentUpdatedAt"
            FROM page_modules pm
            JOIN modules m ON m.id = pm.module_id
            LEFT JOIN page_module_content pmc
              ON pmc.page_id = pm.page_id
             AND pmc.block_name = pm.block_name
             AND pmc.position = pm.position
            WHERE pm.page_id = \${pg.pageId}::uuid
            ORDER BY pm.block_name, pm.position
          \`;
          // Aggregate any footer-ish content into a single text blob for
          // substring assertions.
          const footerRows = await tx\`
            SELECT pmc.content_values::text AS values
            FROM page_module_content pmc
            JOIN page_modules pm
              ON pm.page_id = pmc.page_id
             AND pm.block_name = pmc.block_name
             AND pm.position = pmc.position
            JOIN modules m ON m.id = pm.module_id
            WHERE pmc.page_id = \${pg.pageId}::uuid
              AND (m.slug ILIKE '%footer%' OR pm.block_name ILIKE '%footer%')
          \`;
          out.pageId = pg.pageId;
          out.title = pg.title;
          out.slug = pg.slug;
          out.placements = placements;
          out.footerContentText = footerRows.map(r => r.values).join("\\n");
        });
        await sql.end();
        process.stdout.write(JSON.stringify(out));
      `,
    ],
    { env: { ...process.env, SINCE: sinceTimestamp }, encoding: "utf8" },
  );
  if (raw.status !== 0) {
    throw new Error(`snapshotMostRecentPage failed: ${raw.stderr || raw.stdout}`);
  }
  const trimmed = raw.stdout.trim();
  if (trimmed === "null" || trimmed.length === 0) return null;
  return JSON.parse(trimmed) as PageModuleSnapshot;
}

function countAssistantTurnsWithToolCalls(chatSessionId: string): number {
  const raw = spawnSync(
    "bun",
    [
      "-e",
      `
        import { SQL } from "bun";
        const sql = new SQL(process.env.ADMIN_DATABASE_URL);
        let n = 0;
        await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
          const rows = await tx\`
            SELECT count(*)::int AS n
            FROM chat_messages
            WHERE chat_session_id = \${process.env.CHAT_SESSION_ID}::uuid
              AND role = 'assistant'
              AND tool_calls IS NOT NULL
              AND jsonb_array_length(tool_calls) > 0
          \`;
          n = rows[0]?.n ?? 0;
        });
        await sql.end();
        process.stdout.write(String(n));
      `,
    ],
    { env: { ...process.env, CHAT_SESSION_ID: chatSessionId }, encoding: "utf8" },
  );
  if (raw.status !== 0) {
    throw new Error(`countAssistantTurnsWithToolCalls failed: ${raw.stderr || raw.stdout}`);
  }
  return Number.parseInt(raw.stdout.trim(), 10);
}

test.describe("e2e-livedit Scenario 1 — homepage from scratch", () => {
  test("AI creates a homepage, stages, publishes, re-edits hero — vision verdict + regression guards", async ({
    page,
  }) => {
    // Snapshot the wall-clock so we can isolate pages this scenario
    // creates from any pre-existing seed pages.
    const startTimestamp = new Date().toISOString();

    const tracker = attachChatSessionTracker(page);

    // ── Step 1: Login (AC #4) ──────────────────────────────────────
    await loginAsDevOwner(page);

    // ── Step 2: Open /edit and send the homepage prompt (AC #2) ────
    await page.goto("/edit");
    await sendChatPromptAndWait(page, HOMEPAGE_PROMPT);

    const chatSessionId = tracker.currentSessionId();
    expect(chatSessionId, "Expected the SSE tracker to capture a chat session id").not.toBeNull();
    if (!chatSessionId) throw new Error("unreachable");

    // ── Step 3: Structural assertions (AC #2) ──────────────────────
    // DB: the AI must have created a fresh page with ≥3 placements
    // and a footer-shaped placement whose content_values JSON
    // contains "Caelo" and "MPL 2.0" as substrings.
    const snapshot = snapshotMostRecentPage(startTimestamp);
    expect(
      snapshot,
      "Expected the AI to create a page via add_page tool calls — no pages.updated_at > scenario start. Likely a v0.10.17-class empty-response regression.",
    ).not.toBeNull();
    if (!snapshot) throw new Error("unreachable");
    expect(
      snapshot.placements.length,
      `Expected ≥3 page_modules for ${snapshot.pageId}`,
    ).toBeGreaterThanOrEqual(3);
    expect(
      snapshot.footerContentText,
      `Expected footer module's content_values JSON to contain "Caelo". Got: ${snapshot.footerContentText.slice(0, 500)}`,
    ).toContain("Caelo");
    expect(
      snapshot.footerContentText,
      `Expected footer module's content_values JSON to contain "MPL 2.0". Got: ${snapshot.footerContentText.slice(0, 500)}`,
    ).toContain("MPL 2.0");

    // The runner must have produced at least one assistant turn with
    // tool calls — guards against the empty-response class even
    // when log-grep didn't fire.
    const toolCallTurns = countAssistantTurnsWithToolCalls(chatSessionId);
    expect(
      toolCallTurns,
      `Expected ≥1 chat_messages row with role=assistant AND tool_calls non-empty for ${chatSessionId}`,
    ).toBeGreaterThanOrEqual(1);

    // DOM: assert the preview iframe rendered the page shape. The
    // preview iframe is the chat panel's right-side rail; the test
    // uses Playwright's frameLocator on whichever iframe is loaded.
    const previewFrame = page.frameLocator("iframe").first();
    await expect(
      previewFrame.locator("h1"),
      "Expected the preview iframe to render at least one <h1>",
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(
      previewFrame.locator("footer"),
      "Expected the preview iframe to render a <footer> element",
    ).toBeVisible({ timeout: 30_000 });

    // ── Step 4: Stage + verify staging build (AC #2, #7) ───────────
    await awaitStageComplete(page);
    // Stage triggers a real static-generator run. Browser-side
    // navigation isn't required for this assertion; the action
    // synchronously awaits deploy.trigger.

    // ── Step 5: Publish + vision verdict + regression guards ───────
    await awaitPublishComplete(page);

    const productionUrl = getProductionUrl();
    const productionResponse = await page.request.get(productionUrl);
    expect(productionResponse.status(), `GET ${productionUrl}`).toBeGreaterThanOrEqual(200);
    expect(productionResponse.status(), `GET ${productionUrl}`).toBeLessThan(400);
    const productionBody = await productionResponse.text();
    expect(productionBody, `Production HTML at ${productionUrl} missing "Caelo"`).toContain(
      "Caelo",
    );
    expect(productionBody, `Production HTML at ${productionUrl} missing "MPL 2.0"`).toContain(
      "MPL 2.0",
    );

    // Vision verdict (AC #6, #18) — fail loudly on a non-ok verdict.
    await page.goto(productionUrl);
    const verdict = await verifyPublishedPageWithVision(page);
    expect(verdict.ok, `Vision verdict failed: ${verdict.reason}`).toBe(true);

    // Regression guards (AC #7).
    assertNoOrphanLocks(chatSessionId);
    assertNoChatRunnerDiagWarnings();

    // ── Step 6: Re-edit the hero headline (AC #2 part 2) ───────────
    const preReeditSnapshot = snapshotMostRecentPage(startTimestamp);
    expect(preReeditSnapshot, "snapshot pre-reedit").not.toBeNull();
    if (!preReeditSnapshot) throw new Error("unreachable");

    await page.goto("/edit");
    await sendChatPromptAndWait(page, HERO_REEDIT_PROMPT);

    const postReeditSnapshot = snapshotMostRecentPage(startTimestamp);
    expect(postReeditSnapshot, "snapshot post-reedit").not.toBeNull();
    if (!postReeditSnapshot) throw new Error("unreachable");

    // Same set of placements — re-edit must NOT add/remove placements
    // (no module_id churn beyond updates to existing rows).
    const preKeys = preReeditSnapshot.placements.map((p) => `${p.blockName}/${p.position}`).sort();
    const postKeys = postReeditSnapshot.placements
      .map((p) => `${p.blockName}/${p.position}`)
      .sort();
    expect(postKeys).toEqual(preKeys);

    // At least one placement's content was updated (the hero) — and
    // not all of them (other modules should be untouched). The
    // "exactly one" assertion would require knowing which placement
    // the AI chose for the hero; ">=1 changed, <total" is the
    // looser shape-preservation guarantee the issue asks for.
    const updatedAtPairs = preReeditSnapshot.placements.map((pre, i) => {
      const post = postReeditSnapshot.placements[i];
      return {
        key: `${pre.blockName}/${pre.position}`,
        preUpdatedAt: pre.contentUpdatedAt,
        postUpdatedAt: post?.contentUpdatedAt ?? null,
      };
    });
    const changed = updatedAtPairs.filter(
      (p) =>
        p.preUpdatedAt !== null && p.postUpdatedAt !== null && p.postUpdatedAt > p.preUpdatedAt,
    );
    expect(
      changed.length,
      `Expected ≥1 page_module_content row's updated_at to advance after the hero re-edit. updated_at pairs: ${JSON.stringify(updatedAtPairs)}`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      changed.length,
      `Expected at least one placement to be untouched by the hero re-edit, but all ${updatedAtPairs.length} placements changed.`,
    ).toBeLessThan(updatedAtPairs.length);

    // Final regression-guard sweep.
    assertNoOrphanLocks(chatSessionId);
    assertNoChatRunnerDiagWarnings();
  });
});
