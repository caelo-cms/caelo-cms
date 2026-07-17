// SPDX-License-Identifier: MPL-2.0

/**
 * 2026-07 — add_module carries the placement's initial content IN THE
 * SAME CALL (`values`). Before this, a freshly minted module landed on
 * the page with an EMPTY content_instance and waited for a second
 * set_page_module_content round-trip — the two-step build_page was
 * created to kill, still alive in the singular tool.
 *
 * ONE rule on every target: content arrives via `values`. page/template
 * fill the placement's content_instance; layout stores the values as
 * the minted module's field defaults (chrome has no instance).
 *
 * Boundary rules (Zod):
 *  - mint with fields but neither `values` nor field defaults →
 *    rejected (would render empty placeholders);
 *  - layout + `values` without explicit `fields` → rejected (moduleize
 *    field names are unknowable up front);
 *  - layout + `values` whose keys match no declared field → rejected;
 *  - layout + `moduleId` reuse + `values` → rejected (a shared module
 *    renders its stored defaults; edit_module changes them).
 * Real Postgres (§6) for the apply paths.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { addModuleToolInput, type ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { addModuleTool } from "../ai/tools/add-module.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const TS = Date.now().toString(36);
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "add-module-values",
};
const toolCtx = () => ({ adapter, registry }) as ToolContext;

let pageId = "";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`amv-%-${TS}`})`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`amv-%-${TS}`}`;
      await tx`DELETE FROM layout_modules WHERE module_id IN (SELECT id FROM modules WHERE display_name LIKE 'AMV %')`;
      await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE display_name LIKE 'AMV %')`;
      await tx`DELETE FROM modules WHERE display_name LIKE ${"AMV %"}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`amv-%-${TS}`})`;
      await tx`DELETE FROM templates WHERE slug LIKE ${`amv-%-${TS}`}`;
      await tx`DELETE FROM layout_blocks WHERE layout_id IN (SELECT id FROM layouts WHERE slug LIKE ${`amv-%-${TS}`})`;
      await tx`DELETE FROM layouts WHERE slug LIKE ${`amv-%-${TS}`}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    slug: `amv-tpl-${TS}`,
    displayName: "AMV T",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  if (!tpl.ok) throw new Error("tpl");
  const templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const pg = await execute(registry, adapter, SYSTEM, "pages.create", {
    slug: `amv-page-${TS}`,
    title: "AMV",
    templateId,
  });
  if (!pg.ok) throw new Error("page");
  pageId = (pg.value as { pageId: string }).pageId;
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("add_module — initial content in the same call", () => {
  it("mint on a page with `values` fills the placement's content_instance immediately", async () => {
    const r = await addModuleTool.handler(
      SYSTEM,
      {
        target: "page",
        targetRef: pageId,
        blockName: "content",
        position: 0,
        displayName: "AMV Hero",
        description: "Test hero.",
        kind: "hero",
        html: "<h1>{{title}}</h1>",
        fields: [{ name: "title", kind: "text", label: "Title" }],
        values: { title: "Direct copy, no second call" },
      } as never,
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("Initial content applied");

    // The placement's instance carries the values right away.
    const got = await execute(registry, adapter, SYSTEM, "pages.get_with_modules", { pageId });
    if (!got.ok) throw new Error("get_with_modules");
    const block = (
      got.value as {
        page: { blocks: { blockName: string; modules: { contentInstanceId: string | null }[] }[] };
      }
    ).page.blocks.find((b) => b.blockName === "content");
    const ciId = block?.modules[0]?.contentInstanceId;
    expect(ciId).toBeTruthy();
    const ci = await execute(registry, adapter, SYSTEM, "content_instances.get", {
      id: ciId as string,
    });
    if (!ci.ok) throw new Error("ci get");
    expect(
      (ci.value as { instance: { values: Record<string, unknown> } }).instance.values.title,
    ).toBe("Direct copy, no second call");
  });

  it("schema rejects a page mint whose fields have neither values nor defaults", () => {
    const parsed = addModuleToolInput.safeParse({
      target: "page",
      targetRef: "home",
      blockName: "content",
      position: 0,
      displayName: "AMV Empty",
      html: "<p>{{txt}}</p>",
      fields: [{ name: "txt", kind: "text", label: "Text" }],
      // neither values nor defaults → would render empty placeholders
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain("initial content");
    }
  });

  it("schema accepts a page mint WITHOUT values when the fields carry defaults", () => {
    const parsed = addModuleToolInput.safeParse({
      target: "page",
      targetRef: "home",
      blockName: "content",
      position: 0,
      displayName: "AMV Defaulted",
      html: "<p>{{txt}}</p>",
      fields: [{ name: "txt", kind: "text", label: "Text", default: "fallback copy" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts `values` on target='layout' (one rule everywhere) — but only with explicit fields", () => {
    const ok = addModuleToolInput.safeParse({
      target: "layout",
      targetRef: "site-default",
      blockName: "footer",
      position: 0,
      displayName: "AMV Footer",
      html: "<footer>{{copy}}</footer>",
      fields: [{ name: "copy", kind: "text", label: "Copy" }],
      values: { copy: "© Acme 2026" },
    });
    expect(ok.success).toBe(true);

    // Raw-HTML mint + values: field names are minted by moduleize, so
    // the value keys can't be matched — explicit fields required.
    const noFields = addModuleToolInput.safeParse({
      target: "layout",
      targetRef: "site-default",
      blockName: "footer",
      position: 0,
      displayName: "AMV Footer",
      html: "<footer>(c)</footer>",
      values: { copy: "nope" },
    });
    expect(noFields.success).toBe(false);
    if (!noFields.success) {
      expect(JSON.stringify(noFields.error.issues)).toContain("explicit `fields`");
    }

    // Value keys must name declared fields.
    const badKey = addModuleToolInput.safeParse({
      target: "layout",
      targetRef: "site-default",
      blockName: "footer",
      position: 0,
      displayName: "AMV Footer",
      html: "<footer>{{copy}}</footer>",
      fields: [{ name: "copy", kind: "text", label: "Copy" }],
      values: { copyright: "nope" },
    });
    expect(badKey.success).toBe(false);
    if (!badKey.success) {
      expect(JSON.stringify(badKey.error.issues)).toContain("match no declared field");
    }
  });

  it("rejects `values` with moduleId reuse on a layout (shared module renders stored defaults)", () => {
    const parsed = addModuleToolInput.safeParse({
      target: "layout",
      targetRef: "site-default",
      blockName: "footer",
      position: 0,
      moduleId: "9c5b94b1-35ad-49bb-b118-8e8fc24abf80",
      values: { copy: "nope" },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain("edit_module");
    }
  });

  it("layout mint with `values` stores them as the module's field defaults and echoes the fields", async () => {
    const layout = await execute(registry, adapter, SYSTEM, "layouts.create", {
      slug: `amv-layout-${TS}`,
      displayName: "AMV L",
      html: `<body><caelo-slot name="content">_</caelo-slot><caelo-slot name="footer">_</caelo-slot></body>`,
      blocks: [
        { name: "content", displayName: "Content", position: 0 },
        { name: "footer", displayName: "Footer", position: 1 },
      ],
    });
    if (!layout.ok) throw new Error(`layout: ${JSON.stringify(layout.error)}`);
    const r = await addModuleTool.handler(
      SYSTEM,
      {
        target: "layout",
        targetRef: `amv-layout-${TS}`,
        blockName: "footer",
        position: 0,
        displayName: "AMV Chrome Footer",
        description: "Test chrome.",
        kind: "chrome",
        html: "<footer>{{copy}}</footer>",
        fields: [{ name: "copy", kind: "text", label: "Copy" }],
        values: { copy: "© AMV via values" },
      } as never,
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("Fields: copy(text)");

    const mods = await execute(registry, adapter, SYSTEM, "modules.list", {});
    if (!mods.ok) throw new Error("modules.list");
    const minted = (mods.value as { modules: { id: string; displayName: string }[] }).modules.find(
      (m) => m.displayName === "AMV Chrome Footer",
    );
    expect(minted).toBeDefined();
    const detail = await execute(registry, adapter, SYSTEM, "modules.get", {
      moduleId: (minted as { id: string }).id,
    });
    if (!detail.ok) throw new Error("modules.get");
    const fields = (detail.value as { module: { fields: { name: string; default?: unknown }[] } })
      .module.fields;
    expect(fields.find((f) => f.name === "copy")?.default).toBe("© AMV via values");
  });

  it("page placement result echoes the field names", async () => {
    const r = await addModuleTool.handler(
      SYSTEM,
      {
        target: "page",
        targetRef: pageId,
        blockName: "content",
        position: 0,
        displayName: "AMV Echo",
        description: "Echo test.",
        kind: "content",
        html: "<p>{{body}}</p>",
        fields: [{ name: "body", kind: "text", label: "Body" }],
        values: { body: "echo" },
      } as never,
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("Fields: body(text)");
  });
});
