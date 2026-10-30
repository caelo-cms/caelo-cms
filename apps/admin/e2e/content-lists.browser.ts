// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 part F — *Content → Menus & lists*, page type settings and
 * list entry chips.
 *
 *   1. Edit a menu: add entries, nest one, reorder, save — stored tree checked.
 *   2. Edit its structure: add a field; removing a field that holds values
 *      asks first and saves with the confirmation.
 *   3. Page settings: set a page type, a property and terms.
 *   4. Live Edit: a reference inside a rendered shared-list entry carries the
 *      entry (`listItem`) into the chat chip.
 *   5. A role without `content.structure` sees Structure read-only (and the
 *      action refuses), while the entries stay editable.
 *
 * Every fixture is this spec's own (own list type, so the shipped `menu`
 * type other specs render with is never changed).
 */

import { expect, type Page, test } from "@playwright/test";
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

test.describe.configure({ mode: "serial" });

const PORT = process.env.CAELO_E2E_PORT ?? "4173";
const BASE = `http://localhost:${PORT}`;
const ts = Date.now();
const NAV_TYPE = `e2e-nav-${ts}`;
const MENU = `e2e-menu-${ts}`;
const TOPICS = `e2e-topics-${ts}`;
const PAGE_TYPE = `e2e-article-${ts}`;
const TPL = `e2e-lists-tpl-${ts}`;
const MOD = `e2e-lists-mod-${ts}`;
const PAGE = `e2e-lists-page-${ts}`;
const WRITER_EMAIL = `e2e-writer-${ts}@example.com`;
const WRITER_PASSWORD = "writer dev password";
const PROVIDER = `lists-chip-${ts}`;
let chat: string | null = null;

/** Run admin ops as the system actor in a Bun subprocess; returns stdout. */
function ops(body: string, env: Record<string, string> = {}): string {
  return runBunInline(
    `
    import { SQL } from "bun";
    import { DatabaseAdapter, OperationRegistry, execute } from "@caelo-cms/query-api";
    import { registerAdminOps, hashPassword } from "@caelo-cms/admin-core";
    const adapter = new DatabaseAdapter({ adminDatabaseUrl: process.env.ADMIN_DATABASE_URL, publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL });
    const registry = new OperationRegistry(); registerAdminOps(registry);
    const SYS = { actorId: "00000000-0000-0000-0000-00000000ffff", actorKind: "system", requestId: "e2e-lists" };
    const op = async (name, input) => {
      const r = await execute(registry, adapter, SYS, name, input);
      if (!r.ok) throw new Error(name + ": " + JSON.stringify(r.error));
      return r.value;
    };
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const asSystem = (fn) => sql.begin(async (tx) => { await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'"); return fn(tx); });
    const E = process.env;
    let out = {};
    ${body}
    await sql.end();
    await adapter.close();
    process.stdout.write(JSON.stringify(out));
    `,
    {
      NAV_TYPE,
      MENU,
      TOPICS,
      PAGE_TYPE,
      TPL,
      MOD,
      PAGE,
      WRITER_EMAIL,
      WRITER_PASSWORD,
      ...env,
    },
  );
}

interface StoredItem {
  id: string;
  node: string;
  values: Record<string, unknown>;
  children?: StoredItem[];
}

function storedMenu(): StoredItem[] {
  const out = ops(`
    const rows = await asSystem((tx) => tx\`SELECT items FROM lists WHERE slug = \${E.MENU} AND chat_branch_id IS NULL\`);
    out = rows[0]?.items ?? null;
  `);
  return JSON.parse(out) as StoredItem[];
}

let ids: { templateId: string; pageId: string; topicsId: string; topicIds: string[] };

test.beforeAll(() => {
  clearLoginRateBucket();
  resetOverlayLayoutFor("dev-owner@example.com");
  const out = ops(`
    const navDef = {
      slug: E.NAV_TYPE, name: "E2E navigation", purpose: "Navigation for the lists spec.", role: "navigation",
      root: { allow: ["entry"] },
      nodes: { entry: {
        label: "Menu entry",
        fields: [
          { name: "label", label: "Label", type: "text", required: true },
          { name: "link", label: "Link", type: "link" },
          { name: "note", label: "Note", type: "text" },
        ],
        children: { name: "children", allow: ["entry"] },
        current_from: "link",
      } },
      max_depth: 3,
    };
    await op("list_types.upsert_many", { listTypes: [navDef] });
    await op("lists.upsert_many", { lists: [{ slug: E.MENU, name: "E2E main menu", purpose: "Header navigation of the lists spec.", type: E.NAV_TYPE, items: [] }] });
    await op("lists.upsert_many", { lists: [{ slug: E.TOPICS, name: "E2E topics", purpose: "Topics for the lists spec.", type: "tags", items: [
      { node: "tag", values: { name: "Alpha topic", slug: "alpha" } },
      { node: "tag", values: { name: "Beta topic", slug: "beta" } },
    ] }] });
    const topics = (await op("lists.get", { slug: E.TOPICS })).list;
    out.topicsId = topics.id;
    out.topicIds = topics.items.map((i) => i.id);
    const tpl = await asSystem((tx) => tx\`
      INSERT INTO templates (slug, display_name, html, css, layout_id)
      VALUES (\${E.TPL}, 'Lists spec', '<body><caelo-slot name="content">_</caelo-slot></body>', '', (SELECT id FROM layouts WHERE slug = 'site-default'))
      RETURNING id::text AS id\`);
    out.templateId = tpl[0].id;
    await asSystem(async (tx) => {
      await tx\`INSERT INTO template_blocks (template_id, name, display_name, position) VALUES (\${out.templateId}::uuid, 'content', 'Content', 0)\`;
      await tx\`UPDATE page_types SET definition = jsonb_set(definition, '{templates}', (definition->'templates') || to_jsonb(\${out.templateId}::text)) WHERE id = (SELECT id FROM page_types WHERE slug = 'home' AND chat_branch_id IS NULL AND deleted_at IS NULL)\`;
    });
    await op("page_types.upsert_many", { pageTypes: [{
      slug: E.PAGE_TYPE, name: "E2E article", purpose: "Articles of the lists spec.",
      templates: [out.templateId], defaultTemplate: out.templateId,
      properties: [{ name: "author", label: "Author", type: "text" }],
      vocabularies: [{ list: out.topicsId, cardinality: "many" }],
    }] });
    const menu = (await op("lists.get", { slug: E.MENU })).list;
    const mod = await asSystem((tx) => tx\`
      INSERT INTO modules (slug, display_name, type, html, fields)
      VALUES (\${E.MOD}, 'Lists spec nav', \${E.MOD},
        '<nav class="spec-nav">{{#menu}}<a class="spec-entry" href="{{link}}">{{label}}</a>{{/menu}}</nav>',
        (\${JSON.stringify([{ name: "menu", label: "Menu", kind: "list", listType: E.NAV_TYPE, bind: "shared", list: "caelo:list/" + menu.id }])}::text)::jsonb)
      RETURNING id::text AS id\`);
    const pg = await asSystem((tx) => tx\`
      INSERT INTO pages (slug, title, template_id, status, page_type_id, page_type_confirmed)
      VALUES (\${E.PAGE}, 'Lists spec page', \${out.templateId}::uuid, 'draft', (SELECT id FROM page_types WHERE slug = 'home' AND chat_branch_id IS NULL AND deleted_at IS NULL), true)
      RETURNING id::text AS id\`);
    out.pageId = pg[0].id;
    await asSystem(async (tx) => {
      const ci = await tx\`INSERT INTO content_instances (module_id, "values") VALUES (\${mod[0].id}::uuid, '{}'::jsonb) RETURNING id::text AS id\`;
      await tx\`INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id) VALUES (\${out.pageId}::uuid, 'content', 0, \${mod[0].id}::uuid, \${ci[0].id}::uuid)\`;
    });
    // A role that may write content but not the structure (content.structure
    // is granted to every role with content.write by default — not to this one).
    const pwd = await hashPassword(E.WRITER_PASSWORD);
    await asSystem(async (tx) => {
      const role = await tx\`INSERT INTO roles (name, description) VALUES (\${"e2e-writer-" + E.MENU}, 'Lists spec writer') RETURNING id\`;
      await tx\`INSERT INTO role_permissions (role_id, permission_id) SELECT \${role[0].id}, p.id FROM permissions p WHERE p.name IN ('content.read', 'content.write')\`;
      const actor = await tx\`INSERT INTO actors (kind, display_name) VALUES ('human', 'E2E writer') RETURNING id::text AS id\`;
      await tx\`INSERT INTO users (id, email, password_hash, is_first_owner, onboarded_at) VALUES (\${actor[0].id}::uuid, \${E.WRITER_EMAIL}, \${pwd}, false, now())\`;
      await tx\`INSERT INTO user_roles (user_id, role_id) VALUES (\${actor[0].id}::uuid, \${role[0].id})\`;
    });
  `);
  ids = JSON.parse(out);
});

test.afterAll(async () => {
  if (chat) archiveChat(chat);
  await clearTestProvider(BASE, PROVIDER);
  ops(`
    await asSystem(async (tx) => {
      await tx\`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = \${E.WRITER_EMAIL})\`;
      await tx\`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = \${E.WRITER_EMAIL})\`;
      await tx\`DELETE FROM users WHERE email = \${E.WRITER_EMAIL}\`;
      await tx\`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE name = \${"e2e-writer-" + E.MENU})\`;
      await tx\`DELETE FROM roles WHERE name = \${"e2e-writer-" + E.MENU}\`;
      await tx\`DELETE FROM page_terms WHERE page_id IN (SELECT id FROM pages WHERE slug = \${E.PAGE})\`;
      await tx\`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = \${E.PAGE})\`;
      await tx\`DELETE FROM pages WHERE slug = \${E.PAGE}\`;
      await tx\`DELETE FROM modules WHERE slug = \${E.MOD}\`;
      await tx\`DELETE FROM lists WHERE slug IN (\${E.MENU}, \${E.TOPICS})\`;
      await tx\`DELETE FROM list_types WHERE slug = \${E.NAV_TYPE}\`;
      await tx\`DELETE FROM page_types WHERE slug = \${E.PAGE_TYPE}\`;
    });
  `);
});

async function login(page: Page, email: string, password: string): Promise<void> {
  // Five sign-ins in one file would trip the per-IP login limit.
  clearLoginRateBucket();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15_000 });
}

async function save(page: Page, testId: string): Promise<void> {
  const done = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().includes("?/"),
  );
  await page.getByTestId(testId).click();
  const response = await done;
  // The body carries the server's refusal — the one thing a red run needs.
  expect(response.ok(), await response.text()).toBe(true);
}

test("edit a menu: add, nest, reorder, save", async ({ page }) => {
  await login(page, "dev-owner@example.com", "dev owner password");
  await page.goto("/content/lists");
  await expect(page.getByRole("link", { name: "E2E main menu" })).toBeVisible();
  await page.getByRole("link", { name: "E2E main menu" }).click();
  await expect(page).toHaveURL(`/content/lists/${MENU}`);

  const entries = page.getByTestId("list-entry");
  const addEntry = page.getByRole("button", { name: "Add menu entry", exact: true });
  for (const [label, href] of [
    ["Docs", "https://example.com/docs"],
    ["Guides", "https://example.com/guides"],
    ["Blog", "https://example.com/blog"],
  ] as const) {
    await addEntry.click();
    const form = page.getByTestId("entry-form");
    await form.getByTestId("field-label").locator("input").fill(label);
    await form.getByTestId("field-link").locator("input[type=text]").fill(href);
  }
  await expect(entries).toHaveCount(3);
  // Nest "Guides" under "Docs", then move "Blog" to the top.
  const row = (label: string) => entries.filter({ hasText: label }).first();
  await row("Guides").getByRole("button", { name: "Nest under the entry above" }).first().click();
  await row("Blog").getByRole("button", { name: "Move up" }).first().click();
  // The type's depth rule: nesting is refused where it would exceed max_depth? (3 levels — fine here.)
  await save(page, "save-list");

  const stored = storedMenu();
  expect(stored.map((i) => i.values.label)).toEqual(["Blog", "Docs"]);
  expect(stored[1]?.children?.map((i) => i.values.label)).toEqual(["Guides"]);
  // Paths are stored as typed or as page references — never empty values.
  expect(stored[1]?.values.note).toBeUndefined();

  // After the reload the editor shows the saved tree.
  await page.reload();
  await expect(entries).toHaveCount(3);
  await expect(entries.first()).toContainText("Blog");

  // Drag and drop: drag "Docs" (with its nested "Guides") above "Blog".
  // Upward on purpose: while dragging, the library moves a placeholder
  // and animates the rows (FLIP). Aiming at the bottom edge of "Docs"
  // (the earlier version) put the pointer over the nested "Guides" zone
  // once the rows shifted, so "Blog" sometimes landed INSIDE "Docs".
  // Dragging up, the shifted pointer lies inside the placeholder itself.
  const docsId = await row("Docs").getAttribute("data-entry-id");
  const docs = row("Docs").locator("div").first();
  const blog = row("Blog").locator("div").first();
  const from = await docs.boundingBox();
  const to = await blog.boundingBox();
  if (!from || !to || !docsId) throw new Error("rows have no box");
  await page.mouse.move(from.x + 10, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y + from.height / 2 - 5, { steps: 5 });
  await page.mouse.move(to.x + 10, to.y + 2, { steps: 15 });
  // svelte-dnd-action places the placeholder from the rows' rectangles at
  // each pointermove. When the last move lands while the rows are still in
  // their FLIP animation, it measured mid-flight rectangles and nothing
  // re-evaluates once they settle — the placeholder stays where it was
  // (Playwright smoke on PR #1143 head 941091866). So keep nudging the
  // pointer (1 px) until the placeholder sits first on the top level, and
  // release only then.
  const firstTop = page.locator("ul[aria-label='Entries'] > li").first();
  for (let i = 0; i < 40; i++) {
    if ((await firstTop.getAttribute("data-entry-id")) === docsId) break;
    await page.waitForTimeout(50);
    await page.mouse.move(to.x + 10, to.y + 2 - (i % 2), { steps: 1 });
  }
  await expect(firstTop).toHaveAttribute("data-entry-id", docsId);
  await page.mouse.up();
  await expect(page.getByTestId("save-list")).toBeEnabled();
  await save(page, "save-list");
  const reordered = storedMenu();
  expect(reordered.map((i) => i.values.label)).toEqual(["Docs", "Blog"]);
  expect(reordered[0]?.children?.map((i) => i.values.label)).toEqual(["Guides"]);
});

test("edit its structure: add a field, and confirm removing one with values", async ({ page }) => {
  await login(page, "dev-owner@example.com", "dev owner password");
  await page.goto(`/content/lists/${MENU}/structure`);
  const editor = page.getByTestId("type-editor");
  await expect(editor).toBeVisible();
  await expect(page.getByText("Only this list uses this type.")).toBeVisible();

  // Add a field.
  const node = editor.getByTestId("node-editor").first();
  await node.getByRole("button", { name: "Add field" }).click();
  const added = node.getByTestId("field-def").last();
  await added.getByLabel("Label").fill("Badge");
  await save(page, "save-structure");
  await page.goto(`/content/lists/${MENU}`);
  await page.getByTestId("entry-select").first().click();
  await expect(page.getByTestId("entry-form").getByText("Badge")).toBeVisible();

  // Remove the "link" field, which holds values: the server asks first.
  await page.goto(`/content/lists/${MENU}/structure`);
  const linkField = page.getByTestId("node-editor").first().getByTestId("field-def").nth(1);
  await expect(linkField.getByLabel("Name in templates")).toHaveValue("link");
  // current_from names the link field; clear it so the definition stays valid.
  await page.getByLabel("Highlights the current page by").selectOption("");
  await linkField.getByRole("button", { name: "Remove field" }).click();
  await page.getByTestId("save-structure").click();
  const dialog = page.getByTestId("drop-values-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  const done = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().includes("?/saveType"),
  );
  await dialog.getByTestId("confirm-drop-values").click();
  expect((await done).ok()).toBe(true);
  await expect(dialog).toBeHidden();
  expect(storedMenu()[0]?.values.link).toBeUndefined();
});

test("page settings: page type, property and terms", async ({ page }) => {
  await login(page, "dev-owner@example.com", "dev owner password");
  await page.goto(`/content/pages/${ids.pageId}`);
  const card = page.getByTestId("page-type-settings");
  await card.getByLabel("Type", { exact: true }).selectOption(PAGE_TYPE);
  await card.getByTestId("field-author").locator("input").fill("Ada");
  await card.getByLabel("Beta topic").check();
  await save(page, "save-page-type-settings");

  const out = ops(
    `
    const rows = await asSystem((tx) => tx\`
      SELECT pt.slug, p.properties, (SELECT array_agg(item_id::text) FROM page_terms t WHERE t.page_id = p.id) AS terms
      FROM pages p JOIN page_types pt ON pt.id = p.page_type_id WHERE p.id = \${E.PAGE_ID}::uuid\`);
    out = rows[0];
  `,
    { PAGE_ID: ids.pageId },
  );
  const row = JSON.parse(out) as {
    slug: string;
    properties: Record<string, unknown>;
    terms: string[];
  };
  expect(row.slug).toBe(PAGE_TYPE);
  expect(row.properties).toEqual({ author: "Ada" });
  expect(row.terms).toEqual([ids.topicIds[1]]);
});

test("Live Edit: a reference inside a menu entry carries the entry", async ({ page, context }) => {
  await registerTestProvider(BASE, PROVIDER, [
    { kind: "text-delta", text: "Noted." },
    { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
    { kind: "done", stopReason: "end_turn" },
  ]);
  await attachTestProviderHeader(context, PROVIDER);
  await login(page, "dev-owner@example.com", "dev owner password");
  chat = openOwnerChat(`e2e-lists-chip-${ts}`);
  await page.goto(`/edit?page=${ids.pageId}&chat=${chat}`);
  const preview = page.frameLocator("iframe[title='Live preview']");
  const docs = preview.locator("a.spec-entry", { hasText: "Docs" });
  await expect(docs).toBeVisible({ timeout: 15_000 });
  const stamp = await docs.getAttribute("data-caelo-list-item");
  const menuId = stamp?.split("/")[0] ?? "";
  expect(stamp).toMatch(/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/);

  await docs.click({ button: "right", position: { x: 4, y: 4 } });
  await preview.getByTestId("caelo-menu-reference").click();
  const chip = page.getByTestId("chip");
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText("Entry");
  // A second entry of the same menu is a second chip (same element path).
  await preview
    .locator("a.spec-entry", { hasText: "Blog" })
    .click({ button: "right", position: { x: 4, y: 4 } });
  await preview.getByTestId("caelo-menu-reference").click();
  await expect(chip).toHaveCount(2);

  const composer = page.getByTestId("chat-composer");
  await composer.fill("Rename this entry");
  const request = page.waitForRequest(/\/content\/chat\/[^/]+\/stream$/);
  await page.keyboard.press("Enter");
  const body = (await request).postDataJSON() as { chips: { listItem?: string }[] };
  expect(body.chips[0]?.listItem).toBe(stamp);
  expect(body.chips[1]?.listItem?.startsWith(`${menuId}/`)).toBe(true);
  expect(body.chips[1]?.listItem).not.toBe(stamp);
});

test("without content.structure the Structure tab is read-only", async ({ page, request }) => {
  await login(page, WRITER_EMAIL, WRITER_PASSWORD);
  await page.goto(`/content/lists/${MENU}/structure`);
  await expect(page.getByTestId("structure-readonly")).toBeVisible();
  await expect(page.getByTestId("save-structure")).toHaveCount(0);
  await expect(page.getByTestId("node-editor").first().getByLabel("Entry kind")).toBeDisabled();
  await page.goto("/content/lists/types");
  await expect(page.getByTestId("types-readonly")).toBeVisible();
  // The entries stay editable.
  await page.goto(`/content/lists/${MENU}`);
  await expect(page.getByRole("button", { name: "Add menu entry", exact: true })).toBeVisible();

  // The action refuses too, not only the page.
  const csrf = (await page.locator('input[name="_csrf"]').first().getAttribute("value")) ?? "";
  const cookies = await page.context().cookies();
  const res = await request.post(`/content/lists/${MENU}/structure?/saveType`, {
    headers: {
      cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      origin: BASE,
      "content-type": "application/x-www-form-urlencoded",
    },
    data: new URLSearchParams({ _csrf: csrf, definition: "{}" }).toString(),
    maxRedirects: 0,
  });
  expect(res.status()).toBe(403);
});
