// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #685 — after a Stage, quality-check problems never start the Live
 * Edit AI on their own. The chat shows "Let the AI fix them?" and only the
 * operator's click starts a turn:
 *
 *   1. Operator Stage with findings → the card shows and NO /stream request
 *      goes out; "Fix all with AI" sends one turn whose message carries the
 *      findings by group, the pages and who staged.
 *   1b. #727 — findings grouped by rule across pages: the operator accepts
 *      a picked page, then the rest of a group (the acceptance counts at
 *      once), and lets the AI fix just the remaining group.
 *   2. "Not now" → a status note, the card goes, nothing runs, Publish live
 *      stays blocked.
 *   3. An external agent works in the chat (#682) → the click is refused
 *      with a clear message and no turn starts.
 *
 * The settled audit of the Stage is seeded straight into the tables (the
 * shape the audit worker writes; Lighthouse does not run in this stack).
 * The Stage → enqueue → staged_by path itself is covered by the admin-core
 * integration suite (quality-gate / stage-chats-open-changes).
 */

import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import {
  attachTestProviderHeader,
  clearLoginRateBucket,
  clearTestProvider,
  ensureIsolatedOwner,
  ISOLATED_OWNER_PASSWORD,
  mintAdminMcpToken,
  registerTestProvider,
  runBunInline,
} from "./helpers.js";

test.beforeAll(clearLoginRateBucket);
// Each test seeds the newest staging build; only the newest one's audit
// drives a chat, so the tests run one after another.
test.describe.configure({ mode: "serial" });

const BASE = `http://localhost:${process.env.CAELO_E2E_PORT ?? "4173"}`;
const PROVIDER = `quality-fix-offer-${Date.now()}`;
// This spec's own Owner, so its chats never become another spec's Live
// Edit chat (and the other way round).
const OWNER_EMAIL = "quality-offer-e2e-owner@example.com";
const seededRuns: string[] = [];

test.afterAll(async () => {
  await clearTestProvider(BASE, PROVIDER);
  if (seededRuns.length === 0) return;
  // The deploy runs cascade to their audits: the site's staging gate is
  // back to what it was before this spec.
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      for (const id of JSON.parse(process.env.RUN_IDS)) {
        await tx\`DELETE FROM deploy_runs WHERE id = \${id}::uuid\`;
      }
    });
    await sql.end();
    `,
    { RUN_IDS: JSON.stringify(seededRuns) },
  );
});

async function login(page: Page): Promise<string> {
  const ownerId = ensureIsolatedOwner(OWNER_EMAIL);
  // Three logins in a row, next to parallel specs' logins: stay under the
  // per-IP login limit.
  clearLoginRateBucket();
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(ISOLATED_OWNER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
  return ownerId;
}

async function newChat(page: Page): Promise<string> {
  await page.goto("/content/chat");
  await page.getByRole("button", { name: /\+ new chat/i }).click();
  await expect(page).toHaveURL(/\/content\/chat\/[0-9a-f-]+$/, { timeout: 15_000 });
  return page.url().split("/").pop() ?? "";
}

const SLUG = `qfo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const PAGE_PATH = `/${SLUG}`;

// The audited page: this spec's own published page (a fresh e2e database
// has none, and the audit must name a real page).
test.beforeAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const s = process.env.SLUG;
      const lay = await tx\`INSERT INTO layouts (slug, display_name, html, css)
        VALUES (\${s + "-lay"}, 'L',
                '<!doctype html><html><head><title>{{title}}</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>',
                '') RETURNING id\`;
      const tpl = await tx\`INSERT INTO templates (slug, display_name, html, css, layout_id)
        VALUES (\${s + "-tpl"}, 'T', '<main><caelo-slot name="content">_</caelo-slot></main>',
                '', \${lay[0].id}) RETURNING id\`;
      await tx\`UPDATE page_types SET definition = jsonb_set(definition, '{templates}', (definition->'templates') || to_jsonb(\${tpl[0].id}::text)) WHERE id = (SELECT default_page_type_id FROM site_defaults WHERE id = 1) AND NOT (definition->'templates' ? \${tpl[0].id}::text)\`;
      await tx\`INSERT INTO pages (slug, short_title, title, template_id, status, current_path)
        VALUES (\${s}, \${s}, 'Quality offer', \${tpl[0].id}, 'published', \${process.env.PAGE_PATH})\`;
      // #727 — two more pages, so one rule can fail across pages.
      for (const x of ["b", "c"]) {
        await tx\`INSERT INTO pages (slug, short_title, title, template_id, status, current_path)
          VALUES (\${s + "-" + x}, \${s + "-" + x}, 'Quality offer ' || \${x}, \${tpl[0].id}, 'published',
                  \${process.env.PAGE_PATH + "-" + x})\`;
      }
    });
    await sql.end();
    `,
    { SLUG, PAGE_PATH },
  );
});

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const s = process.env.SLUG;
      await tx\`DELETE FROM quality_acceptances WHERE page_id IN
        (SELECT id FROM pages WHERE slug IN (\${s}, \${s + "-b"}, \${s + "-c"}))\`;
      await tx\`DELETE FROM pages WHERE slug IN (\${s}, \${s + "-b"}, \${s + "-c"})\`;
      await tx\`DELETE FROM templates WHERE slug = \${s + "-tpl"}\`;
      await tx\`DELETE FROM layouts WHERE slug = \${s + "-lay"}\`;
    });
    await sql.end();
    `,
    { SLUG },
  );
});

/**
 * A settled audit of this chat's Stage that found one problem on this
 * spec's page: a fresh succeeded staging run (so it is the build Publish
 * would ship) plus its `problems` audit.
 */
function seedProblemAudit(
  chatSessionId: string,
  ownerId: string,
  stagedBy: "operator" | "other_agent",
  shape: "single" | "grouped" = "single",
): void {
  const runId = runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const id = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const target = (await tx\`SELECT id FROM deploy_targets WHERE name = 'staging'\`)[0];
      if (!target) throw new Error("quality-fix-offer e2e: no staging deploy target");
      const page = (await tx\`SELECT id::text AS id FROM pages WHERE slug = \${process.env.SLUG}\`)[0];
      // Dated ahead so a Stage another spec runs meanwhile cannot replace
      // it as the build Publish would ship (that withdraws the offer). The
      // afterAll deletes it.
      const run = (await tx\`INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at, build_id)
        VALUES (\${target.id}, \${process.env.OWNER_ID}::uuid, 'succeeded', now() + interval '1 hour',
                now() + interval '1 hour', 'e2e-quality-offer')
        RETURNING id::text AS id\`)[0];
      const contrast = { kind: "failing_audit", auditId: "color-contrast", title: "Low contrast text", score: 0, categories: ["accessibility"] };
      // #727 — "grouped": one page-check rule failing on all three pages,
      // plus Accessibility 92 on the first.
      const missing = { kind: "check_rule", checkId: "seo-check", ruleId: "seo-check/description-missing", count: 1, allowed: 0, findings: [{ message: "Missing meta description" }] };
      const a11y = { kind: "score_below_baseline", category: "accessibility", score: 92, baseline: 100 };
      const grouped = process.env.SHAPE === "grouped";
      const slugs = grouped
        ? [process.env.SLUG, process.env.SLUG + "-b", process.env.SLUG + "-c"]
        : [process.env.SLUG];
      const pages = [];
      for (const slug of slugs) {
        pages.push((await tx\`SELECT id::text AS id FROM pages WHERE slug = \${slug}\`)[0]);
      }
      const problemsOf = (i) => (grouped ? (i === 0 ? [missing, a11y] : [missing]) : [contrast]);
      const total = pages.reduce((n, _p, i) => n + problemsOf(i).length, 0);
      const audit = (await tx\`INSERT INTO quality_audit_runs
          (deploy_run_id, chat_session_id, requested_by, status, classification, target_page_ids,
           problem_count, started_at, finished_at, fix_round, staged_by)
        VALUES (\${run.id}::uuid, \${process.env.CHAT_ID}::uuid, \${process.env.OWNER_ID}::uuid, 'problems',
          \${JSON.stringify({ auditNeeded: true, reasons: [], skipped: [] })}::jsonb,
          ARRAY[\${page.id}::uuid], \${total}, now(), now(), 0, \${process.env.STAGED_BY})
        RETURNING id::text AS id\`)[0];
      for (const [i, p] of pages.entries()) {
        await tx\`INSERT INTO quality_audit_pages (audit_run_id, page_id, url, status, problems)
          VALUES (\${audit.id}::uuid, \${p.id}::uuid, 'http://staging.invalid/', 'problems',
            \${JSON.stringify(problemsOf(i))}::jsonb)\`;
      }
      return run.id;
    });
    process.stdout.write(id);
    await sql.end();
    `,
    { CHAT_ID: chatSessionId, OWNER_ID: ownerId, STAGED_BY: stagedBy, SLUG, SHAPE: shape },
  ).trim();
  seededRuns.push(runId);
}

/** Every chat-turn request this page sends from now on. */
function watchStreamRequests(page: Page, chatSessionId: string): { body: string }[] {
  const sent: { body: string }[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith(`/content/chat/${chatSessionId}/stream`)) {
      sent.push({ body: req.postData() ?? "" });
    }
  });
  return sent;
}

async function qualityStatus(
  request: APIRequestContext,
  chatSessionId: string,
): Promise<{ notified: boolean; gate: { open: boolean } | null }> {
  const res = await request.get(`/content/chat/${chatSessionId}/quality-audit`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as { notified: boolean; gate: { open: boolean } | null };
}

test("an operator Stage with findings asks first; only 'Fix all with AI' starts the AI", async ({
  context,
  page,
}) => {
  await registerTestProvider(BASE, PROVIDER, [
    [
      { kind: "text-delta", text: "Fixing the contrast now." },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ],
  ]);
  await attachTestProviderHeader(context, PROVIDER);
  const ownerId = await login(page);
  const chatSessionId = await newChat(page);
  seedProblemAudit(chatSessionId, ownerId, "operator");
  const path = PAGE_PATH;
  const sent = watchStreamRequests(page, chatSessionId);
  await page.reload();

  const card = page.getByTestId("quality-fix-offer");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("Quality check found 1 kind(s) of issue on 1 page(s)");
  await expect(card).toContainText("Low contrast text (1 page(s))");
  await expect(card).toContainText("Staged by you.");
  await expect(card).toContainText("Let the AI fix them");
  await expect(card.getByTestId("quality-offer-group")).toHaveAttribute(
    "data-group-key",
    "lighthouse/accessibility/color-contrast",
  );
  // Long enough for the old auto-send (it fired as soon as the chat was idle).
  await page.waitForTimeout(5_000);
  expect(sent).toHaveLength(0);

  await card.getByTestId("quality-fix-offer-fix").click();
  await expect.poll(() => sent.length, { timeout: 15_000 }).toBe(1);
  const body = JSON.parse(sent[0]?.body ?? "{}") as {
    content: string;
    origin?: string;
    trigger?: string;
  };
  expect(body.trigger).toBe("operator");
  expect(body.content).toContain("Fix round 1:");
  expect(body.content).toContain(
    `- lighthouse/accessibility/color-contrast — Low contrast text: 1 page(s) (${path})`,
  );
  // #727 — the AI is held to the optimum.
  expect(body.content).toContain("a score like 90 is NOT good enough on its own");
  expect(body.content).toContain("I staged this build myself");
  expect(body.content).toContain("can also contain changes made outside this conversation");
  await expect(page.getByText("Fixing the contrast now.")).toBeVisible({ timeout: 20_000 });
  await expect(card).toHaveCount(0, { timeout: 15_000 });
  await expect
    .poll(async () => (await qualityStatus(page.request, chatSessionId)).notified, {
      timeout: 15_000,
    })
    .toBe(true);
  expect(sent).toHaveLength(1);
});

// Regression: the card stayed up ~20 s after "Fix with AI" (CI flake on
// PR #717) because the status poller DROPPED the post-ack refresh while an
// older refresh — one that had read the state before the ack committed —
// was still on the wire. The network is shaped so that exact interleaving
// happens every time: the status read is answered late, the ack lands
// while it is pending. The card must go with the next refresh, not the
// next 20 s poll tick.
test("the offer goes away after 'Fix with AI' even when a status read was in flight", async ({
  context,
  page,
}) => {
  await registerTestProvider(BASE, PROVIDER, [
    [
      { kind: "text-delta", text: "Fixing it under a slow status read." },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ],
  ]);
  await attachTestProviderHeader(context, PROVIDER);
  const ownerId = await login(page);
  const chatSessionId = await newChat(page);
  seedProblemAudit(chatSessionId, ownerId, "operator");
  const statusUrl = `/content/chat/${chatSessionId}/quality-audit`;
  await page.route(`**${statusUrl}`, async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      // Read the state now, answer late: the read predates the ack below.
      const res = await route.fetch();
      await new Promise((r) => setTimeout(r, 1_500));
      await route.fulfill({ response: res });
      return;
    }
    if ((req.postData() ?? "").includes('"ack"')) {
      // Let the stream finish and its status read go out first.
      await new Promise((r) => setTimeout(r, 300));
    }
    await route.continue();
  });
  await page.reload();

  const card = page.getByTestId("quality-fix-offer");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByTestId("quality-fix-offer-fix").click();
  await expect(page.getByText("Fixing it under a slow status read.")).toBeVisible({
    timeout: 20_000,
  });
  // Well under the 20 s idle poll interval: only a refresh that was not
  // dropped can hide the card in time.
  await expect(card).toHaveCount(0, { timeout: 10_000 });
  await expect
    .poll(async () => (await qualityStatus(page.request, chatSessionId)).notified, {
      timeout: 15_000,
    })
    .toBe(true);
});

test("'Not now' leaves a note and runs nothing; Publish live stays blocked", async ({ page }) => {
  const ownerId = await login(page);
  const chatSessionId = await newChat(page);
  seedProblemAudit(chatSessionId, ownerId, "operator");
  const sent = watchStreamRequests(page, chatSessionId);
  await page.reload();

  const card = page.getByTestId("quality-fix-offer");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByTestId("quality-fix-offer-dismiss").click();
  await expect(page.getByText("Not now — the AI was not asked to fix")).toBeVisible({
    timeout: 15_000,
  });
  await expect(card).toHaveCount(0);
  const st = await qualityStatus(page.request, chatSessionId);
  expect(st.notified).toBe(true);
  expect(st.gate?.open).toBe(false);
  // The decision holds across a reload, and nothing ever started the AI.
  await page.reload();
  await expect(page.getByText("Not now — the AI was not asked to fix")).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(3_000);
  await expect(card).toHaveCount(0);
  expect(sent).toHaveLength(0);
});

test("'Fix with AI' is refused while an external agent works in the chat", async ({
  page,
  request,
}) => {
  const ownerId = ensureIsolatedOwner(OWNER_EMAIL);
  const token = mintAdminMcpToken(ownerId, "quality-offer agent");
  const sessionRes = await request.post("/api/mcp/session", {
    headers: { "x-caelo-mcp-token": token },
    data: { newSession: true, title: `quality-offer-${Date.now()}` },
  });
  expect(sessionRes.ok()).toBe(true);
  const { chatSessionId } = (await sessionRes.json()) as { chatSessionId: string };
  // One call marks the agent as working in the chat.
  const tool = await request.post("/api/mcp/tool", {
    headers: { "x-caelo-mcp-token": token },
    data: { chatSessionId, toolName: "list_pages", args: {} },
  });
  expect(tool.ok(), await tool.text()).toBe(true);
  seedProblemAudit(chatSessionId, ownerId, "other_agent");

  await login(page);
  const sent = watchStreamRequests(page, chatSessionId);
  await page.goto(`/content/chat/${chatSessionId}`);
  const card = page.getByTestId("quality-fix-offer");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("Staged by another agent working in this chat.");
  await card.getByTestId("quality-fix-offer-fix").click();
  await expect(page.getByTestId("quality-fix-offer-error")).toContainText(
    "is working in this chat right now",
    { timeout: 15_000 },
  );
  expect(sent).toHaveLength(0);
  expect((await qualityStatus(page.request, chatSessionId)).notified).toBe(false);
});

test("bulk decisions per group: pick and accept, accept all, fix one group (#727)", async ({
  context,
  page,
}) => {
  await registerTestProvider(BASE, PROVIDER, [
    [
      { kind: "text-delta", text: "Raising the accessibility score now." },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ],
  ]);
  await attachTestProviderHeader(context, PROVIDER);
  const ownerId = await login(page);
  const chatSessionId = await newChat(page);
  seedProblemAudit(chatSessionId, ownerId, "operator", "grouped");
  const sent = watchStreamRequests(page, chatSessionId);
  await page.reload();

  const card = page.getByTestId("quality-fix-offer");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("Quality check found 2 kind(s) of issue on 3 page(s)");
  const groups = card.getByTestId("quality-offer-group");
  await expect(groups).toHaveCount(2);
  const missing = card.locator('[data-group-key="seo-check/description-missing"]');
  const a11y = card.locator('[data-group-key="lighthouse/accessibility/score"]');
  await expect(missing).toContainText("3 page(s)");
  await expect(a11y).toContainText("1 page(s)");

  // Pick one page of the big group and accept just that one.
  await missing.getByTestId("quality-offer-group-pick").click();
  await missing
    .locator(`[data-testid="quality-offer-pick-page"][data-page-path="${PAGE_PATH}-b"]`)
    .check();
  await missing.getByTestId("quality-offer-group-accept").click();
  await missing.getByTestId("quality-offer-accept-reason").fill("archived page, no SEO value");
  await expect(missing.getByTestId("quality-offer-accept-confirm")).toHaveText(
    "Accept on 1 page(s)",
  );
  await missing.getByTestId("quality-offer-accept-confirm").click();
  await expect(missing).toContainText("2 page(s)", { timeout: 15_000 });

  // Then the rest of the group in one decision.
  await missing.getByTestId("quality-offer-group-accept").click();
  await missing.getByTestId("quality-offer-accept-reason").fill("legacy landing pages");
  await expect(missing.getByTestId("quality-offer-accept-confirm")).toHaveText(
    "Accept on 2 page(s)",
  );
  await missing.getByTestId("quality-offer-accept-confirm").click();
  await expect(missing).toHaveCount(0, { timeout: 15_000 });
  await expect(groups).toHaveCount(1);
  // Accepting never started the AI.
  expect(sent).toHaveLength(0);

  // The remaining group: the AI fixes just that one.
  await a11y.getByTestId("quality-offer-group-fix").click();
  await expect.poll(() => sent.length, { timeout: 15_000 }).toBe(1);
  const body = JSON.parse(sent[0]?.body ?? "{}") as { content: string };
  expect(body.content).toContain("these quality findings I picked: 1 group(s) on 1 page(s)");
  expect(body.content).toContain("lighthouse/accessibility/score");
  expect(body.content).not.toContain("seo-check/description-missing");
  await expect(page.getByText("Raising the accessibility score now.")).toBeVisible({
    timeout: 20_000,
  });
});

// Regression (found while fixing the Real-AI accept loop, PR #783): during
// an accept the panel hid the whole card, and when the POST returned it
// re-rendered from the PRE-accept status — the accepted group was back on
// screen until the next status read landed, as if the accept had failed.
// The network is shaped so every stale path shows: each status read is
// taken at once but answered only after the NEXT accept has returned. The
// card must stay up the whole time, and a group's page count may only go
// down — it never reappears with pages already accepted.
test("an accept never flashes the card or shows the accepted group again (#783)", async ({
  page,
}) => {
  // The bulk test above accepted this rule on these pages; start the
  // group from all three pages again.
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const s = process.env.SLUG;
      await tx\`DELETE FROM quality_acceptances WHERE page_id IN
        (SELECT id FROM pages WHERE slug IN (\${s}, \${s + "-b"}, \${s + "-c"}))\`;
    });
    await sql.end();
    `,
    { SLUG },
  );
  const ownerId = await login(page);
  const chatSessionId = await newChat(page);
  seedProblemAudit(chatSessionId, ownerId, "operator", "grouped");
  const sent = watchStreamRequests(page, chatSessionId);
  await page.reload();

  const card = page.getByTestId("quality-fix-offer");
  await expect(card).toBeVisible({ timeout: 30_000 });
  const missing = card.locator('[data-group-key="seo-check/description-missing"]');
  await expect(missing).toHaveAttribute("data-page-count", "3");

  // From here on, every status read holds its (already read) answer until
  // released — so a read started before an accept lands after it.
  const held: (() => void)[] = [];
  let holding = true;
  await page.route(`**/content/chat/${chatSessionId}/quality-audit`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    if (holding) await new Promise<void>((release) => held.push(release));
    await route.fulfill({ response: res });
  });
  const releaseHeld = (): void => {
    for (const release of held.splice(0)) release();
  };

  // Record every state of the card the operator could see.
  await page.evaluate(() => {
    const w = window as unknown as { __qfo: { cardGone: boolean; counts: string[] } };
    w.__qfo = { cardGone: false, counts: [] };
    const look = (): void => {
      if (!document.querySelector('[data-testid="quality-fix-offer"]')) w.__qfo.cardGone = true;
      const g = document.querySelector('[data-group-key="seo-check/description-missing"]');
      const count = g?.getAttribute("data-page-count") ?? "none";
      if (w.__qfo.counts.at(-1) !== count) w.__qfo.counts.push(count);
    };
    look();
    new MutationObserver(look).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-page-count"],
    });
  });

  const acceptPosted = () =>
    page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url().endsWith(`/content/chat/${chatSessionId}/quality-audit`) &&
        (r.request().postData() ?? "").includes('"accept"'),
    );

  // Accept one picked page: the card shows the shrunk group at once, with
  // the read that follows the accept still held.
  await missing.getByTestId("quality-offer-group-pick").click();
  await missing
    .locator(`[data-testid="quality-offer-pick-page"][data-page-path="${PAGE_PATH}-b"]`)
    .check();
  await missing.getByTestId("quality-offer-group-accept").click();
  await missing.getByTestId("quality-offer-accept-reason").fill("archived page, no SEO value");
  const first = acceptPosted();
  await missing.getByTestId("quality-offer-accept-confirm").click();
  expect((await first).ok()).toBe(true);
  await expect(missing).toHaveAttribute("data-page-count", "2", { timeout: 5_000 });

  // Accept the rest while that read is still on the wire, then let it land:
  // it predates this accept and must not bring the group back.
  await missing.getByTestId("quality-offer-group-accept").click();
  await missing.getByTestId("quality-offer-accept-reason").fill("legacy landing pages");
  await expect(missing.getByTestId("quality-offer-accept-confirm")).toHaveText(
    "Accept on 2 page(s)",
  );
  const second = acceptPosted();
  await missing.getByTestId("quality-offer-accept-confirm").click();
  expect((await second).ok()).toBe(true);
  await expect(missing).toHaveCount(0, { timeout: 5_000 });
  holding = false;
  releaseHeld();
  // Give the released (stale) reads and the fresh re-read time to land.
  await expect.poll(() => held.length).toBe(0);
  await page.waitForTimeout(2_000);
  await expect(missing).toHaveCount(0);

  const seen = await page.evaluate(
    () => (window as unknown as { __qfo: { cardGone: boolean; counts: string[] } }).__qfo,
  );
  expect(seen.cardGone).toBe(false);
  expect(seen.counts).toEqual(["3", "2", "none"]);
  expect(sent).toHaveLength(0);
});
