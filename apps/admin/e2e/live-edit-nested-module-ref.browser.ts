// SPDX-License-Identifier: MPL-2.0

/**
 * #1027 — sub-modules in a `module-list` field carry their own
 * `data-caelo-module-id`, so the live-edit overlay resolves an element to
 * the module that rendered it: right-clicking an FAQ entry references the
 * entry module (whose template and content hold that markup), right-
 * clicking the FAQ section's own heading still references the placed
 * module and keeps its in-place "Edit text". Before, every nested element
 * was attributed to the enclosing placement.
 */

import { expect, test } from "@playwright/test";
import {
  archiveChat,
  attachTestProviderHeader,
  clearLoginRateBucket,
  clearTestProvider,
  openOwnerChat,
  registerTestProvider,
  resetOverlayLayoutFor,
  runBunInline,
} from "./helpers.js";

const BASE = `http://localhost:${process.env.CAELO_E2E_PORT ?? "4173"}`;
const ts = Date.now();
/** This spec's own Live Edit chat (#1081); archived in afterAll. */
let chat: string | null = null;
const PROVIDER = `le-nested-ref-${ts}`;
const TPL_SLUG = `e2e-le-nested-tpl-${ts}`;
const FAQ_SLUG = `e2e-le-nested-faq-${ts}`;
const ENTRY_SLUG = `e2e-le-nested-entry-${ts}`;
const PAGE_SLUG = `e2e-le-nested-page-${ts}`;
const SLUGS = { TPL_SLUG, FAQ_SLUG, ENTRY_SLUG, PAGE_SLUG };

test.beforeAll(() => {
  clearLoginRateBucket();
  resetOverlayLayoutFor("dev-owner@example.com");
});

test.afterAll(async () => {
  if (chat) archiveChat(chat);
  await clearTestProvider(BASE, PROVIDER);
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = \${process.env.PAGE_SLUG})\`;
      await tx\`DELETE FROM pages WHERE slug = \${process.env.PAGE_SLUG}\`;
      await tx\`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug IN (\${process.env.FAQ_SLUG}, \${process.env.ENTRY_SLUG}))\`;
      await tx\`DELETE FROM modules WHERE slug IN (\${process.env.FAQ_SLUG}, \${process.env.ENTRY_SLUG})\`;
      await tx\`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = \${process.env.TPL_SLUG})\`;
      await tx\`DELETE FROM templates WHERE slug = \${process.env.TPL_SLUG}\`;
    });
    await sql.end();
    `,
    SLUGS,
  );
});

test("a right-click inside a sub-module references the sub-module, outside it the placement", async ({
  page,
  context,
}) => {
  const seed = runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const out = {};
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const tpl = await tx\`
        INSERT INTO templates (slug, display_name, html, css, layout_id)
        VALUES (\${process.env.TPL_SLUG}, 'le', '<body><caelo-slot name="content">_</caelo-slot></body>', '', (SELECT id FROM layouts WHERE slug = 'site-default'))
        RETURNING id::text AS id\`;
      await tx\`UPDATE page_types SET definition = jsonb_set(definition, '{templates}', (definition->'templates') || to_jsonb(\${tpl[0].id}::text)) WHERE id = (SELECT default_page_type_id FROM site_defaults WHERE id = 1) AND NOT (definition->'templates' ? \${tpl[0].id}::text)\`;
      await tx\`INSERT INTO template_blocks (template_id, name, display_name, position) VALUES (\${tpl[0].id}::uuid, 'content', 'Content', 0)\`;
      const entryFields = JSON.stringify([
        { name: "question", kind: "text", label: "Question" },
        { name: "answer", kind: "text", label: "Answer" },
      ]);
      const entry = await tx\`
        INSERT INTO modules (slug, display_name, type, html, fields)
        VALUES (\${process.env.ENTRY_SLUG}, 'FAQ entry', \${process.env.ENTRY_SLUG}, '<details class="faq-item" open><summary>{{question}}</summary><p>{{answer}}</p></details>', \${entryFields}::text::jsonb)
        RETURNING id::text AS id\`;
      const faqFields = JSON.stringify([
        { name: "title", kind: "text", label: "Title" },
        { name: "items", kind: "module-list", label: "Entries" },
      ]);
      const faq = await tx\`
        INSERT INTO modules (slug, display_name, type, html, fields)
        VALUES (\${process.env.FAQ_SLUG}, 'FAQ', \${process.env.FAQ_SLUG}, '<section class="faq"><h2>{{title}}</h2>{{#items}}{{/items}}</section>', \${faqFields}::text::jsonb)
        RETURNING id::text AS id\`;
      const items = [];
      for (const [q, a] of [["NESTED_Q_ONE", "First answer"], ["NESTED_Q_TWO", "Second answer"]]) {
        const v = JSON.stringify({ question: q, answer: a });
        const ci = await tx\`INSERT INTO content_instances (module_id, "values") VALUES (\${entry[0].id}::uuid, \${v}::text::jsonb) RETURNING id::text AS id\`;
        items.push({ moduleId: entry[0].id, contentInstanceId: ci[0].id });
      }
      const pg = await tx\`
        INSERT INTO pages (slug, title, template_id, status)
        VALUES (\${process.env.PAGE_SLUG}, 'LE Nested Page', \${tpl[0].id}::uuid, 'draft')
        RETURNING id::text AS id\`;
      const values = JSON.stringify({ title: "FAQ_TITLE", items });
      const ci = await tx\`INSERT INTO content_instances (module_id, "values") VALUES (\${faq[0].id}::uuid, \${values}::text::jsonb) RETURNING id::text AS id\`;
      await tx\`INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id) VALUES (\${pg[0].id}::uuid, 'content', 0, \${faq[0].id}::uuid, \${ci[0].id}::uuid)\`;
      out.pg = pg[0].id;
      out.faq = faq[0].id;
      out.entry = entry[0].id;
    });
    await sql.end();
    process.stdout.write(JSON.stringify(out));
    `,
    SLUGS,
  );
  const ids = JSON.parse(seed) as { pg: string; faq: string; entry: string };

  await registerTestProvider(BASE, PROVIDER, [
    { kind: "text-delta", text: "Noted." },
    { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
    { kind: "done", stopReason: "end_turn" },
  ]);
  await attachTestProviderHeader(context, PROVIDER);

  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
  // #1081 — a chat of this spec's own: without `chat=`, Live Edit resumes
  // dev-owner's most recent chat, which a parallel spec may have opened on
  // an experiment branch or be running a turn in.
  chat = openOwnerChat(`e2e-le-nested-${ts}`);
  await page.goto(`/edit?page=${ids.pg}&chat=${chat}`);

  const preview = page.frameLocator("iframe[title='Live preview']");
  const section = preview.locator(`section[data-caelo-module-id="${ids.faq}"]`);
  const heading = section.locator("h2");
  await expect(heading).toHaveText("FAQ_TITLE", { timeout: 15_000 });
  // Every entry root carries the entry module's id.
  const entries = section.locator(`details.faq-item[data-caelo-module-id="${ids.entry}"]`);
  await expect(entries).toHaveCount(2);

  // The placement's own field: in-place editing and a placement reference.
  await heading.click({ button: "right", position: { x: 8, y: 8 } });
  await expect(preview.getByTestId("caelo-menu-edit")).toBeVisible();
  await preview.getByTestId("caelo-menu-reference").click();
  await expect(page.getByTestId("chip")).toHaveCount(1);

  // Inside an entry: the reference names the entry module.
  await entries
    .first()
    .locator("summary")
    .click({ button: "right", position: { x: 8, y: 8 } });
  await expect(preview.getByTestId("caelo-context-menu")).toBeVisible();
  await preview.getByTestId("caelo-menu-reference").click();
  await expect(page.getByTestId("chip")).toHaveCount(2);

  const streamRequest = page.waitForRequest(/\/content\/chat\/[^/]+\/stream$/);
  await page.getByTestId("chat-composer").fill("Tighten these");
  await page.keyboard.press("Enter");
  const body = (await streamRequest).postDataJSON() as {
    chips: { moduleId: string; selector: string }[];
  };
  expect(body.chips.map((c) => [c.moduleId, c.selector])).toEqual([
    [ids.faq, "section.faq > h2"],
    [ids.entry, "details.faq-item > summary"],
  ]);
  await expect(page.getByText("Noted.").last()).toBeVisible({ timeout: 15_000 });
});
