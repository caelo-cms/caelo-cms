// SPDX-License-Identifier: MPL-2.0

/**
 * #1149 — when add_module placed the module but its `values` did not fit,
 * the error said only that applying them failed. The placement exists, so
 * re-running add_module places the module twice. The error now says it is
 * placed, where, how to fill it (set_page_module_content_many), and which
 * fields the list type's entries take — no op names (`list_types.get`).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { addModuleTool } from "../ai/tools/add-module.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const TS = Date.now().toString(36);
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "i1149",
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

describe("#1149 — add_module values failure after placement", () => {
  it("says the module is placed and how to fill it", async () => {
    const { templateId } = await op<{ templateId: string }>("templates.create", {
      pageType: "home",
      slug: `i1149-tpl-${TS}`,
      displayName: "T",
      html: '<body><caelo-slot name="content">_</caelo-slot></body>',
    });
    await op("template_blocks.set", {
      templateId,
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });
    const { pageId } = await op<{ pageId: string }>("pages.create", {
      slug: `i1149-${TS}`,
      title: "I1149",
      templateId,
    });
    const { moduleId } = await op<{ moduleId: string }>("modules.create", {
      slug: `i1149-chips-${TS}`,
      displayName: "Chips",
      html: "<ul>{{#chips}}<li>{{text}}</li>{{/chips}}</ul>",
      fields: [{ name: "chips", kind: "list", label: "Chips", listType: "texts" }],
    });

    const r = await addModuleTool.handler(
      SYSTEM,
      {
        target: "page",
        targetRef: pageId,
        blockName: "content",
        position: 0,
        moduleId,
        values: { chips: [{ node: "text", values: { title: "Fast" } }] },
      } as never,
      { registry, adapter } as unknown as ToolContext,
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain(
      `the module IS placed (page ${pageId}, block "content", position 0)`,
    );
    expect(r.content).toContain("set_page_module_content_many");
    expect(r.content).toContain('Entries of list type "texts" take: text {text*}');
    expect(r.content).not.toContain("list_types.get");
  });
});
