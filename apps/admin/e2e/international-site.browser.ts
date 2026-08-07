// SPDX-License-Identifier: MPL-2.0

/**
 * #400 — international-site plugin arc (mock AI, epic #380):
 *   - the gated `set_locales` call PAUSES the turn on the in-chat
 *     approval card (§11.A / Plan B): the card renders, NOTHING is
 *     written before the click, and Approve resumes the turn
 *   - the ungated `create_variant` plugin tool dispatches through the
 *     real chat-runner: the German counterpart lands under /de/ with a
 *     localized slug as a draft
 *   - published variants cross-link via hreflang (incl. x-default) in
 *     the rendered page head — the #391 contribution path end-to-end
 *
 * Since issue #442 the FixtureProvider replays scripted events through
 * a MockLanguageModelV3 under the REAL SDK multi-step loop — so a
 * plain scripted `tool-call` on the gated `set_locales` exercises the
 * genuine needsApproval pause AND the genuine post-Approve execute.
 * This is the full production approval cycle, mock model only.
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import {
  attachTestProviderHeader,
  clearLoginRateBucket,
  clearTestProvider,
  registerTestProvider,
  runBunInline,
} from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

const ts = Date.now();
const SRC_SLUG = `t400-pricing-${ts}`;
const DE_SLUG = `t400-preise-${ts}`;
const PROVIDER = `international-site-${ts}`;
const BASE = "http://localhost:4173";

interface SeedResult {
  pageId: string;
}

function seedSourcePage(): SeedResult {
  const raw = spawnSync(
    "bun",
    [
      "-e",
      `
      import { SQL } from "bun";
      const sql = new SQL(process.env.ADMIN_DATABASE_URL);
      let out;
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const lay = await tx\`INSERT INTO layouts (slug, display_name, html, css)
          VALUES (\${process.env.SRC_SLUG + "-lay"}, 'L',
                  '<!doctype html><html><head><title>{{title}}</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>',
                  '') RETURNING id\`;
        const tpl = await tx\`INSERT INTO templates (slug, display_name, kind, html, css, layout_id)
          VALUES (\${process.env.SRC_SLUG + "-tpl"}, 'T', 'content',
                  '<main><caelo-slot name="content">_</caelo-slot></main>',
                  '', \${lay[0].id}) RETURNING id\`;
        await tx\`INSERT INTO layout_blocks (layout_id, name, display_name, position)
          VALUES (\${lay[0].id}, 'content', 'Content', 0)\`;
        await tx\`INSERT INTO template_blocks (template_id, name, display_name, position)
          VALUES (\${tpl[0].id}, 'content', 'Content', 0)\`;
        const pg = await tx\`INSERT INTO pages (slug, name, title, template_id, status)
          VALUES (\${process.env.SRC_SLUG}, \${process.env.SRC_SLUG}, 'Pricing', \${tpl[0].id}, 'published')
          RETURNING id\`;
        out = { pageId: pg[0].id };
      });
      await sql.end();
      console.log(JSON.stringify(out));
      `,
    ],
    { env: { ...process.env, SRC_SLUG }, encoding: "utf8" },
  );
  if (raw.status !== 0) throw new Error(`seed failed: ${raw.stderr || raw.stdout}`);
  return JSON.parse(raw.stdout.trim().split("\n").at(-1) ?? "{}") as SeedResult;
}

test.afterEach(async () => {
  await clearTestProvider(BASE, PROVIDER);
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      // Plugin-schema rows are RLS-scoped to caelo.plugin_id. The
      // schema itself only exists after an Owner activated the plugin
      // (the loader provisions it then), so a run that failed before
      // the Activate click has a plugins ROW but no relations.
      const plug = await tx\`SELECT id FROM plugins WHERE slug = 'international-site'\`;
      const provisioned = await tx.unsafe(
        "SELECT to_regclass('plugin_international_site.page_variants') IS NOT NULL AS ok",
      );
      if (plug[0] && provisioned[0]?.ok) {
        await tx.unsafe(\`SET LOCAL caelo.plugin_id = '\${plug[0].id}'\`);
        await tx.unsafe("DELETE FROM plugin_international_site.page_variants");
        await tx.unsafe("DELETE FROM plugin_international_site.locales");
      }
      await tx\`DELETE FROM redirects WHERE from_path LIKE \${"/" + process.env.SRC + "%"} OR from_path LIKE \${"/de/" + process.env.SRC + "%"}\`;
      await tx\`DELETE FROM pages WHERE slug LIKE \${process.env.SRC + "%"} OR slug LIKE \${process.env.DE + "%"}\`;
      await tx\`DELETE FROM templates WHERE slug LIKE \${process.env.SRC + "%"}\`;
      await tx\`DELETE FROM layouts WHERE slug LIKE \${process.env.SRC + "%"}\`;
    });
    await sql.end();
    `,
    { SRC: SRC_SLUG, DE: DE_SLUG },
  );
});

test("gated set_locales pauses for the in-chat click; create_variant lands /de/; published variants cross-link via hreflang", async ({
  context,
  page,
  request,
}) => {
  const seed = seedSourcePage();

  await registerTestProvider(BASE, PROVIDER, [
    // Turn 1 — the gated locale change: a plain tool-call; the SDK
    // derives the approval pause from the tool's approvalMode.
    [
      {
        kind: "tool-call",
        id: "tu_locales",
        name: "set_locales",
        arguments: {
          locales: [
            { code: "en", displayName: "English", urlStrategy: "none", isDefault: true },
            { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: false },
          ],
        },
      },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "tool_use" },
    ],
    // Resume after Approve.
    [
      { kind: "text-delta", text: "Locale change approved." },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ],
    // Turn 2 — the ungated variant mint dispatches for real.
    [
      {
        kind: "tool-call",
        id: "tu_variant",
        name: "create_variant",
        arguments: {
          sourcePageId: seed.pageId,
          localeCode: "de",
          slug: DE_SLUG,
          title: "Preise",
        },
      },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "tool_use" },
    ],
    [
      { kind: "text-delta", text: "The /de/ pricing draft is ready." },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ],
  ]);
  await attachTestProviderHeader(context, PROVIDER);

  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  // The plugin is installed but NOT running until an Owner activates
  // it — its tools are absent from the catalogue, so the scripted
  // `set_locales` call below would have nothing to dispatch to. This
  // click is the same one a real install makes, and it exercises
  // activate → loader → tool registration for real.
  await page.goto("/security/plugins");
  const activate = page.getByTestId("activate-international-site");
  if ((await activate.count()) > 0) {
    await activate.click();
    await expect(page.getByTestId("activate-international-site")).toHaveCount(0, {
      timeout: 30_000,
    });
  }

  await page.goto("/content/chat");
  await page.getByRole("button", { name: /\+ new chat/i }).click();
  await expect(page).toHaveURL(/\/content\/chat\/[0-9a-f-]+$/, { timeout: 15_000 });
  await page.locator("textarea").fill("add German to the site and create the German pricing page");
  await page.getByRole("button", { name: /^send$/i }).click();

  // §11.A: the turn PAUSES on the approval card — before the click the
  // locale registry must be empty (the gate is real, not cosmetic).
  const approveButton = page.getByTestId("chat-approval-approve");
  await expect(approveButton).toBeVisible({ timeout: 15_000 });
  runBunInline(`
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const plug = await tx\`SELECT id FROM plugins WHERE slug = 'international-site'\`;
      if (!plug[0]) throw new Error("international-site plugin not loaded in the e2e admin");
      await tx.unsafe(\`SET LOCAL caelo.plugin_id = '\${plug[0].id}'\`);
      return tx.unsafe("SELECT code FROM plugin_international_site.locales");
    });
    await sql.end();
    if (rows.length !== 0) throw new Error("locales written BEFORE the Owner's Approve click: " + JSON.stringify(rows));
  `);

  await approveButton.click();
  await expect(page.getByText(/Locale change approved/i)).toBeVisible({ timeout: 30_000 });

  // The Approve click ran the REAL execute (SDK-owned): the registry
  // now holds exactly the two approved locales.
  runBunInline(`
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const plug = await tx\`SELECT id FROM plugins WHERE slug = 'international-site'\`;
      await tx.unsafe(\`SET LOCAL caelo.plugin_id = '\${plug[0].id}'\`);
      return tx.unsafe("SELECT code FROM plugin_international_site.locales ORDER BY code");
    });
    await sql.end();
    const codes = rows.map((r) => r.code).join(",");
    if (codes !== "de,en") throw new Error("approved execute did not apply the locales: " + codes);
  `);

  await page.locator("textarea").fill("now create the German pricing page");
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect(page.getByText(/The \/de\/ pricing draft is ready/i)).toBeVisible({
    timeout: 30_000,
  });

  // The counterpart exists as a draft at /de/<localized slug>, grouped
  // with its source — and the write happened only AFTER the click.
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const state = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const plug = await tx\`SELECT id FROM plugins WHERE slug = 'international-site'\`;
      await tx.unsafe(\`SET LOCAL caelo.plugin_id = '\${plug[0].id}'\`);
      const page = await tx\`SELECT id, status, current_path FROM pages WHERE slug = \${process.env.DE_SLUG}\`;
      const variants = await tx.unsafe("SELECT page_id, locale_code, translation_status FROM plugin_international_site.page_variants");
      return { page: page[0], variants };
    });
    await sql.end();
    if (!state.page) throw new Error("de counterpart page missing");
    if (state.page.status !== "draft") throw new Error("counterpart must land as a DRAFT, got " + state.page.status);
    if (state.page.current_path !== "/de/" + process.env.DE_SLUG) throw new Error("wrong current_path: " + state.page.current_path);
    if (state.variants.length !== 2) throw new Error("expected a 2-variant group, got " + JSON.stringify(state.variants));
    `,
    { DE_SLUG },
  );

  // Publish both → the rendered head carries the full hreflang set.
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`UPDATE pages SET status = 'published' WHERE slug IN (\${process.env.SRC_SLUG}, \${process.env.DE_SLUG})\`;
    });
    await sql.end();
    `,
    { SRC_SLUG, DE_SLUG },
  );
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const res = await request.get(`${BASE}/content/pages/${seed.pageId}/preview`, {
    headers: { cookie: cookieHeader },
  });
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain(`hreflang="de"`);
  expect(html).toContain(`/de/${DE_SLUG}`);
  expect(html).toContain(`hreflang="x-default"`);
});
