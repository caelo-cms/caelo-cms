// SPDX-License-Identifier: MPL-2.0

/**
 * #1264 — a placement value for a field whose module fixes the shared list
 * was refused with an op name (`lists.patch_items_many`, not a tool) and the
 * list only as `caelo:list/<uuid>`, while `patch_list_items_many` takes the
 * list's slug. The refusal now names the slug and carries the ready call,
 * and the tool layer says tool names (set_page_module_content_many did not
 * map them). Real Postgres (§6), through the tool registry's dispatch.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { ToolRegistry } from "../ai/tools/dispatch.js";
import { setPageModuleContentManyTool } from "../ai/tools/set-page-module-content-many.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const TS = Date.now().toString(36);
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "i1264",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

async function op<T>(name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYSTEM, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await adapter.close();
});

describe("#1264 — shared-bound list refusal", () => {
  it("names the list slug and the ready patch_list_items_many call", async () => {
    const slug = `i1264-categories-${TS}`;
    const { lists } = await op<{ lists: { id: string }[] }>("lists.upsert_many", {
      lists: [
        {
          slug,
          name: "Categories",
          purpose: "Blog categories shown in the sidebar.",
          type: "texts",
          items: [{ node: "text", values: { text: "News" } }],
        },
      ],
    });
    const listId = lists[0]?.id as string;
    const { templateId } = await op<{ templateId: string }>("templates.create", {
      pageType: "home",
      slug: `i1264-tpl-${TS}`,
      displayName: "T",
      html: '<body><caelo-slot name="content">_</caelo-slot></body>',
    });
    await op("template_blocks.set", {
      templateId,
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });
    const { pageId } = await op<{ pageId: string }>("pages.create", {
      slug: `i1264-${TS}`,
      title: "I1264",
      templateId,
    });
    const { moduleId } = await op<{ moduleId: string }>("modules.create", {
      slug: `i1264-cats-${TS}`,
      displayName: "Categories",
      html: "<ul>{{#categories}}<li>{{text}}</li>{{/categories}}</ul>",
      fields: [
        {
          name: "categories",
          kind: "list",
          label: "Categories",
          listType: "texts",
          bind: "shared",
          list: `caelo:list/${listId}`,
        },
      ],
    });
    await op("pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [moduleId] }],
    });

    const tools = new ToolRegistry();
    tools.register(setPageModuleContentManyTool);
    const r = await tools.dispatch(
      "set_page_module_content_many",
      {
        items: [
          {
            pageId,
            blockName: "content",
            position: 0,
            contentValues: { categories: [{ node: "text", values: { text: "Tips" } }] },
          },
        ],
      },
      SYSTEM,
      { adapter, registry },
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain(`the shared list "${slug}"`);
    expect(r.content).toContain(`patch_list_items_many({lists: [{slug: "${slug}", patches: [`);
    expect(r.content).toContain(`get_list with slug "${slug}"`);
    expect(r.content).toContain("leave categories out of values");
    expect(r.content).toContain("set_page_module_content_many failed");
    expect(r.content).not.toContain("lists.patch_items_many");
    expect(r.content).not.toContain("page_module_content.set_many");
    expect(r.content).not.toContain("caelo:list/");
  });
});
