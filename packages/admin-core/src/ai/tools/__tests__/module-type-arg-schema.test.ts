// SPDX-License-Identifier: MPL-2.0

/**
 * issue #106 (step-09 optimization #2) — the AI-facing `type` argument on the
 * module-authoring tools must carry the SAME slug pattern the Zod Validator
 * enforces (moduleCreateSchema.type / moduleUpdateSchema.type = slugSchema).
 *
 * Without the pattern in the provider-facing JSON inputSchema, a model doing
 * constrained generation could emit a `type` like "Primary Button" that the
 * Validator then rejects — the exact provider-vs-Zod divergence class issue
 * #106 closed for `allowedModuleTypes`. This pins both tools' `type` arg to
 * the canonical slugSchema regex so the two surfaces can't drift apart.
 */

import { describe, expect, it } from "bun:test";
import { addModuleTool } from "../add-module.js";
import { editModuleTool } from "../edit-module.js";

// Mirror of slugSchema's regex source in @caelo-cms/shared (content.ts).
const SLUG_PATTERN = "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$";

function typeArg(schema: Record<string, unknown>): Record<string, unknown> {
  const props = schema.properties as Record<string, Record<string, unknown>>;
  return props.type;
}

describe("module-authoring tools — `type` arg mirrors the Zod slug pattern (#106 opt 2)", () => {
  it("add_module.inputSchema.type carries the slug pattern", () => {
    const t = typeArg(addModuleTool.inputSchema);
    expect(t.type).toBe("string");
    expect(t.pattern).toBe(SLUG_PATTERN);
  });

  it("edit_module.inputSchema.type carries the slug pattern", () => {
    const t = typeArg(editModuleTool.inputSchema);
    expect(t.type).toBe("string");
    expect(t.pattern).toBe(SLUG_PATTERN);
  });

  it("the pattern actually accepts a slug-shaped type and rejects a spaced one", () => {
    const re = new RegExp(SLUG_PATTERN);
    expect(re.test("button")).toBe(true);
    expect(re.test("primary-button")).toBe(true);
    expect(re.test("Primary Button")).toBe(false);
    expect(re.test("-leading")).toBe(false);
  });
});
