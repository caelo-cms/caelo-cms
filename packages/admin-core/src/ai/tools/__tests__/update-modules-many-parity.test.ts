// SPDX-License-Identifier: MPL-2.0

/**
 * `update_modules_many` must expose the SAME per-module authoring surface as
 * `edit_module` — it is the bulk form of the same op (modules.update_many loops
 * modules.update). Its schema used to be a hand-written subset
 * `{moduleId, displayName, html, css, js}` that `.strict()`-rejected
 * `fields` / `kind` / `description` / `type`, so a bulk edit could not
 * restructure a module's field schema and the AI had to fall back to N×
 * edit_module — the exact N+1 chain the bulk tool exists to replace.
 *
 * These tests pin that the bulk schema accepts the full shape (so it can never
 * silently become a subset of the op again) and that its JSON inputSchema
 * exposes the meta + fields props.
 */

import { describe, expect, it } from "bun:test";
import { updateModulesManyTool } from "../bulk-pages-modules.js";

const UUID = "11111111-1111-4111-8111-111111111101";

describe("update_modules_many carries the full edit_module shape", () => {
  it("Zod schema accepts a per-module `fields` + `kind` + `description` edit", () => {
    const r = updateModulesManyTool.schema.safeParse({
      updates: [
        {
          moduleId: UUID,
          displayName: "Hero",
          description: "Homepage hero",
          kind: "hero",
          type: "hero-banner",
          html: "<h1>{{hero_title}}</h1>",
          fields: [{ name: "hero_title", kind: "text", label: "Hero title" }],
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("still accepts the body-only edit (the common case)", () => {
    const r = updateModulesManyTool.schema.safeParse({
      updates: [{ moduleId: UUID, css: ".hero{color:red}" }],
    });
    expect(r.success).toBe(true);
  });

  it("JSON inputSchema exposes fields + kind/type/description on each item", () => {
    const props = updateModulesManyTool.inputSchema.properties as Record<string, unknown>;
    const items = (props.updates as { items: { properties: Record<string, unknown> } }).items;
    for (const key of ["fields", "kind", "type", "description", "html", "css", "js"]) {
      expect(items.properties[key]).toBeDefined();
    }
  });
});
