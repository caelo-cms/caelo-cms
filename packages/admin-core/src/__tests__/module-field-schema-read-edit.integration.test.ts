// SPDX-License-Identifier: MPL-2.0

/**
 * #1100 — the AI can read a module's full field schema (`read_content`
 * `field:"fields"`) and an `update_modules_many` that resends a field
 * without `default` keeps the stored default instead of dropping it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext, ModuleField } from "@caelo-cms/shared";
import { updateModulesManyTool } from "../ai/tools/bulk-pages-modules.js";
import { readContentTool } from "../ai/tools/read-content.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const TS = Date.now().toString(36);
const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "i1100-sys",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let toolCtx: Parameters<typeof updateModulesManyTool.handler>[2];

async function op<T>(name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  toolCtx = { registry, adapter } as unknown as typeof toolCtx;
});

afterAll(async () => {
  await adapter.close();
});

describe("#1100 — module field schema: read and patch", () => {
  it("read_content shows every field's label, default and bounds; a resend without default keeps it", async () => {
    const { moduleId } = await op<{ moduleId: string }>("modules.create", {
      slug: `i1100-${TS}`,
      displayName: "Section",
      html: "<section><h2>{{heading}}</h2><div>{{#items}}{{>.}}{{/items}}</div></section>",
      fields: [
        { name: "heading", kind: "text", label: "Heading", default: "Our services" },
        {
          name: "items",
          kind: "module-list",
          label: "Items",
          allowedModuleTypes: ["card"],
          max: 6,
        },
      ],
    });

    const read = await readContentTool.handler(
      SYS,
      { entityKind: "module", entityId: moduleId, field: "fields" },
      toolCtx,
    );
    expect(read.ok).toBe(true);
    expect(read.content).toContain('"default": "Our services"');
    expect(read.content).toContain('"allowedModuleTypes"');
    expect(read.content).toContain('"max": 6');

    // The whole-body read lists the schema too.
    const all = await readContentTool.handler(
      SYS,
      { entityKind: "module", entityId: moduleId },
      toolCtx,
    );
    expect(all.content).toContain("# fields");

    // Widen one field; resend the other without its default.
    const res = await updateModulesManyTool.handler(
      SYS,
      {
        items: [
          {
            moduleId,
            fields: [
              { name: "heading", kind: "text", label: "Heading" },
              {
                name: "items",
                kind: "module-list",
                label: "Items",
                allowedModuleTypes: ["card", "teaser"],
                max: 6,
              },
            ] as ModuleField[],
          },
        ],
      },
      toolCtx,
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain("Kept the stored default of: heading");

    const after = await op<{ module: { fields: ModuleField[] } }>("modules.get", { moduleId });
    const heading = after.module.fields.find((f) => f.name === "heading");
    const items = after.module.fields.find((f) => f.name === "items");
    expect(heading && "default" in heading ? heading.default : undefined).toBe("Our services");
    expect(items?.kind === "module-list" ? items.allowedModuleTypes : []).toEqual([
      "card",
      "teaser",
    ]);
  });
});
