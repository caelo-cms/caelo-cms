// SPDX-License-Identifier: MPL-2.0

/**
 * Live Edit's Staging menu and the Publish live review (decisions
 * 2026-11-17).
 *
 *   - The Staging button counts the draft changes of all the operator's own
 *     conversations ("2 draft changes"); its menu lists them, the one on
 *     screen first, highlighted and the only one ticked, with Stage now,
 *     Open chat, Show details, Stage selected and Stage all. The yellow
 *     "Also pending" strip is gone.
 *   - Publish live opens a review first: the numbers, three examples per
 *     area, redirects of one pattern as one row, Publish live at the top
 *     and the bottom, and the staged run it showed in its form.
 *
 * Seeded through the real ops for an Owner of this spec's own. The review
 * reads `GET /api/deploy/publish-preview`, answered here with a fixed
 * release (`page.route`): a seeded live build would be every other spec's
 * live build too while it ran. The op behind it is covered against real
 * Postgres (deploy-publish-preview.integration.test.ts). The quality
 * check's status is answered as unavailable, so the gate never closes
 * Publish live here: the gate has its own specs.
 */

import { expect, type Page, test } from "@playwright/test";
import {
  clearLoginRateBucket,
  ensureIsolatedOwner,
  ISOLATED_OWNER_PASSWORD,
  resetOverlayLayoutFor,
  runBunInline,
} from "./helpers.js";

const OWNER_EMAIL = "draft-review-e2e-owner@example.com";
const TAG = `e2e-dr-${Date.now()}`;
let chats: { b: string; c: string; run: string };

test.describe.configure({ mode: "serial" });
// Two sign-ins in a row: start each from an empty login bucket, so this
// spec never uses up the attempts of a spec running beside it.
test.beforeEach(clearLoginRateBucket);

test.beforeAll(() => {
  clearLoginRateBucket();
  const ownerId = ensureIsolatedOwner(OWNER_EMAIL);
  resetOverlayLayoutFor(OWNER_EMAIL);
  const out = runBunInline(
    `
    import { SQL } from "bun";
    import { DatabaseAdapter, OperationRegistry, execute } from "@caelo-cms/query-api";
    import { registerAdminOps } from "@caelo-cms/admin-core";
    const tag = process.env.DR_TAG;
    const adapter = new DatabaseAdapter({
      adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
      publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
    });
    const registry = new OperationRegistry();
    registerAdminOps(registry);
    const human = { actorId: process.env.OWNER_ID, actorKind: "human", requestId: tag };
    const run = async (ctx, op, input) => {
      const r = await execute(registry, adapter, ctx, op, input);
      if (!r.ok) throw new Error(op + ": " + JSON.stringify(r.error));
      return r.value;
    };
    const open = async (title) => {
      const s = await run(human, "chat.create_session", { title: tag + " " + title });
      return { id: s.chatSessionId, ctx: { ...human, actorKind: "ai", chatBranchId: s.chatBranchId, chatTaskId: s.chatSessionId } };
    };
    const moduleOf = async (slug) =>
      (await run(human, "modules.create", { slug: tag + "-" + slug, displayName: tag + " " + slug, html: "<p>v0</p>" })).moduleId;
    // C is older; B is the conversation the operator has on screen.
    const c = await open("Footer work");
    await run(c.ctx, "modules.update", { moduleId: await moduleOf("footer"), html: "<p>from C</p>" });
    const b = await open("Pricing rework");
    await run(b.ctx, "modules.update", { moduleId: await moduleOf("pricing"), html: "<p>from B</p>" });
    await adapter.close();
    // A staged build to publish (the shape a succeeded Stage writes); dated
    // now, so another spec's newer Stage is just as good a staged build.
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const runId = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const target = (await tx\`SELECT id FROM deploy_targets WHERE name = 'staging'\`)[0];
      if (!target) throw new Error("draft-review e2e: no staging deploy target");
      return (await tx\`INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at, build_id)
        VALUES (\${target.id}, \${process.env.OWNER_ID}::uuid, 'succeeded', now(), now(), 'e2e-draft-review')
        RETURNING id::text AS id\`)[0].id;
    });
    await sql.end();
    process.stdout.write(JSON.stringify({ b: b.id, c: c.id, run: runId }));
    `,
    { DR_TAG: TAG, OWNER_ID: ownerId },
  );
  chats = JSON.parse(out) as typeof chats;
});

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM deploy_runs WHERE id = \${process.env.RUN_ID}::uuid\`;
      await tx\`UPDATE chat_sessions SET archived_at = now() WHERE title LIKE \${process.env.DR_TAG + "%"}\`;
    });
    await sql.end();
    `,
    { RUN_ID: chats.run, DR_TAG: TAG },
  );
});

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(ISOLATED_OWNER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
}

test("the Staging menu lists the operator's conversations, this one first and ticked", async ({
  page,
}) => {
  await login(page);
  await page.goto(`/edit?chat=${chats.b}`);
  const staging = page.getByTestId("staging-menu");
  await expect(staging).toContainText("2 draft changes", { timeout: 15_000 });
  // The yellow "Also pending" strip is gone.
  await expect(page.getByTestId("cross-chat-banner")).toHaveCount(0);

  await staging.click();
  const cards = page.getByTestId("draft-chat");
  await expect(cards).toHaveCount(2);
  const first = cards.first();
  await expect(first).toHaveAttribute("data-chat-id", chats.b);
  await expect(first).toHaveAttribute("data-active", "true");
  await expect(first).toContainText("This chat");
  await expect(first.getByTestId("draft-chat-select")).toBeChecked();
  const other = page.locator(`[data-testid="draft-chat"][data-chat-id="${chats.c}"]`);
  await expect(other.getByTestId("draft-chat-select")).not.toBeChecked();
  await expect(other.getByTestId("open-chat-link")).toHaveAttribute(
    "href",
    `/edit?chat=${chats.c}`,
  );
  await expect(page.getByTestId("stage-selected")).toHaveText("Stage selected (1)");
  await expect(page.getByTestId("stage-all")).toHaveText("Stage all (2)");

  await other.getByTestId("draft-chat-details-toggle").click();
  await expect(other.getByTestId("draft-chat-details")).toContainText(`${TAG} footer`);
  await expect(other.getByTestId("draft-chat-details")).toContainText("Section design");
  await other.getByTestId("draft-chat-select").check();
  await expect(page.getByTestId("stage-selected")).toHaveText("Stage selected (2)");
});

const STAGED_AT = "2026-11-17T14:32:00.000Z";

/** A release of 6 pages, one site-wide part, one setting and 50 redirects. */
function release(stagedRunId: string) {
  const page = (n: string) => ({
    pageId: `00000000-0000-4000-8000-0000000000${n}`,
    title: `Page ${n}`,
    path: `/p-${n}`,
  });
  const moved = Array.from({ length: 48 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    revision: 1,
    fromPath: `/blog/2024/post-${i}`,
    toPath: `/news/post-${i}`,
    origin: "page_move",
  }));
  return {
    preview: {
      staged: { runId: stagedRunId, startedAt: STAGED_AT, finishedAt: STAGED_AT },
      live: { runId: "live-run", finishedAt: "2026-11-12T09:00:00.000Z", stagedRunId: "older-run" },
      liveMatchesStaging: false,
      notice: null,
      pages: {
        new: { total: 1, items: [page("01")] },
        changed: { total: 4, items: [page("02"), page("03"), page("04"), page("05")] },
        removed: { total: 1, items: [page("06")] },
      },
      siteWide: [
        { key: "list:l1", kind: "list", change: "changed", title: "Main navigation", what: "List" },
      ],
      settings: [{ key: "setting:organization_json", title: "Organization JSON-LD" }],
    },
    redirects: {
      goingLive: [
        ...moved,
        {
          id: "10000000-0000-4000-8000-000000000001",
          revision: 2,
          fromPath: "/plans",
          toPath: "/pricing",
          origin: "manual",
        },
        {
          id: "10000000-0000-4000-8000-000000000002",
          revision: 1,
          fromPath: "/faq-old",
          toPath: "/faq",
          origin: "manual",
        },
      ],
      waiting: [
        {
          id: "10000000-0000-4000-8000-000000000003",
          revision: 1,
          fromPath: "/webinar",
          toPath: "/events/webinar",
          origin: "manual",
          reason: "target",
        },
      ],
      draft: [],
      problem: null,
    },
  };
}

test("Publish live opens the review first: numbers, examples, Publish live at the top", async ({
  page,
}) => {
  await page.route("**/api/deploy/publish-preview", (route) =>
    route.fulfill({ json: release(chats.run) }),
  );
  // The gate stays unknown here (it never closes Publish live client-side).
  await page.route("**/content/chat/*/quality-audit", (route) => route.fulfill({ status: 503 }));
  const published: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("?/promoteToProduction")) published.push(r.url());
  });

  await login(page);
  await page.goto(`/edit?chat=${chats.b}`);
  await page.getByTestId("promote-btn").click({ timeout: 15_000 });

  const review = page.getByTestId("publish-review");
  await expect(review).toBeVisible();
  // Publish live is reachable before scrolling, and again at the bottom.
  await expect(review.getByTestId("publish-review-confirm-top")).toBeEnabled();
  await expect(review.getByTestId("publish-review-confirm")).toBeEnabled();

  const tiles = review.getByTestId("publish-review-tile");
  await expect(tiles.nth(0)).toContainText("6");
  await expect(tiles.nth(0)).toContainText("1 new · 4 changed · 1 removed");
  await expect(tiles.nth(2)).toContainText("50");
  await expect(tiles.nth(2)).toContainText("1 waits for their page");

  // Three examples, one of each kind first; the rest on request.
  const pages = review.getByTestId("publish-review-pages");
  await expect(pages.locator("li")).toHaveCount(3);
  await pages.getByRole("button", { name: "Show all 6" }).click();
  await expect(pages.locator("li")).toHaveCount(6);

  // 48 moved posts are one row with their count.
  const redirects = review.getByTestId("publish-redirects-going");
  await expect(redirects.locator("li").first()).toContainText("/blog/2024/… → /news/…");
  await expect(redirects.locator("li").first()).toContainText("48");
  await review.getByRole("button", { name: "Show all 50" }).click();
  await review.getByLabel("Search redirects").fill("faq");
  await expect(review.getByText("1 of 50")).toBeVisible();

  await expect(review.getByTestId("publish-review-site-wide")).toContainText("Main navigation");
  await expect(review.getByTestId("publish-review-settings")).toContainText("Organization JSON-LD");
  await expect(review.getByTestId("publish-review-drafts")).toContainText(
    "Your 2 draft changes are not in this build",
  );
  // The form names the build it showed: deploy.promote refuses another one.
  await expect(review.locator('input[name="stagedRunId"]')).toHaveValue(chats.run);

  await review.getByRole("button", { name: "Cancel" }).first().click();
  await expect(review).toHaveCount(0);
  expect(published).toEqual([]);
});
