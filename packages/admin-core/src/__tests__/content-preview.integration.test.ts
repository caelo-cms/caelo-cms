// SPDX-License-Identifier: MPL-2.0

/**
 * End-to-end preview rendering: seeded template + 2 modules → composed HTML
 * containing the slot fill, module CSS in `<style data-source="modules">`,
 * module JS in `<script defer data-source="modules">`. Exercises the same op
 * the SvelteKit preview endpoint will call.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo/query-api";
import type { ExecutionContext } from "@caelo/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"];
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "content-preview-test",
};

const TPL_SLUG = "p3-preview-tpl";
const MOD_SLUGS = ["p3-preview-mod-a", "p3-preview-mod-b"] as const;
const PAGE_SLUG = "p3-preview-page";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${PAGE_SLUG})`;
      await tx`DELETE FROM pages WHERE slug = ${PAGE_SLUG}`;
      for (const slug of MOD_SLUGS) await tx`DELETE FROM modules WHERE slug = ${slug}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
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
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("pages.render_preview", () => {
  it("composes the template HTML with two modules in slot order, plus stamped CSS/JS", async () => {
    const tpl = await execute(registry, adapter, systemCtx, "templates.create", {
      slug: TPL_SLUG,
      displayName: "Preview T",
      html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
      css: "body{font-family:sans-serif}",
    });
    if (!tpl.ok) throw new Error("tpl seed");
    const templateId = (tpl.value as { templateId: string }).templateId;
    await execute(registry, adapter, systemCtx, "template_blocks.set", {
      templateId,
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });

    const m1 = await execute(registry, adapter, systemCtx, "modules.create", {
      slug: MOD_SLUGS[0],
      displayName: "A",
      html: "<p>HELLO_A</p>",
      css: ".a{color:red}",
      js: "window.A=1;",
    });
    if (!m1.ok) throw new Error("m1 seed");
    const m2 = await execute(registry, adapter, systemCtx, "modules.create", {
      slug: MOD_SLUGS[1],
      displayName: "B",
      html: "<p>HELLO_B</p>",
      css: ".b{color:blue}",
      js: "window.B=1;",
    });
    if (!m2.ok) throw new Error("m2 seed");

    const pg = await execute(registry, adapter, systemCtx, "pages.create", {
      slug: PAGE_SLUG,
      title: "P",
      templateId,
    });
    if (!pg.ok) throw new Error("page seed");
    const pageId = (pg.value as { pageId: string }).pageId;
    await execute(registry, adapter, systemCtx, "pages.set_modules", {
      pageId,
      blocks: [
        {
          blockName: "content",
          moduleIds: [
            (m1.value as { moduleId: string }).moduleId,
            (m2.value as { moduleId: string }).moduleId,
          ],
        },
      ],
    });

    const r = await execute(registry, adapter, systemCtx, "pages.render_preview", { pageId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { html, replacedSlots, missingSlots } = r.value as {
      html: string;
      replacedSlots: string[];
      missingSlots: string[];
    };
    expect(replacedSlots).toEqual(["content"]);
    expect(missingSlots).toEqual([]);
    expect(html).toContain("HELLO_A");
    expect(html).toContain("HELLO_B");
    expect(html.indexOf("HELLO_A")).toBeLessThan(html.indexOf("HELLO_B"));
    expect(html).toContain(`<style data-source="modules">`);
    expect(html).toContain(".a{color:red}");
    expect(html).toContain(".b{color:blue}");
    expect(html).toContain(`<script defer data-source="modules">`);
    expect(html).toContain("window.A=1;");
    expect(html).toContain("window.B=1;");
  });
});
