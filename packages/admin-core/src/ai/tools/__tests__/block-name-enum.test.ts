// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.3 (issue #106) — guards for the generation-time blockName enum.
 * withBlockNameEnum must pin the block argument to the focused page's
 * blocks when one is in context, and fall back to the static free-string
 * schema otherwise (an empty enum would match nothing and wedge the model;
 * the op-layer Validator is the defense-in-depth).
 */

import { describe, expect, it } from "bun:test";
import { blockNotFoundError, withBlockNameEnum } from "../_block-name-enum.js";
import { buildToolDescribeState, type ToolDescribeStateActivePage } from "../describe-state.js";

const BASE = {
  type: "object",
  additionalProperties: false,
  required: ["blockName"],
  properties: {
    blockName: { type: "string", minLength: 1, maxLength: 80 },
  },
} as const;

const ACTOR = { actorId: "00000000-0000-0000-0000-000000000001", actorKind: "ai" as const };

function stateWith(activePage: ToolDescribeStateActivePage | null) {
  return buildToolDescribeState({
    actor: ACTOR,
    layoutsValue: null,
    templatesValue: null,
    siteDefaultsValue: null,
    activePage,
  });
}

describe("withBlockNameEnum", () => {
  it("pins blockName to an enum of the focused page's blocks", () => {
    const state = stateWith({ id: "p1", templateId: "t1", blockNames: ["content", "footer"] });
    const schema = withBlockNameEnum(BASE, state, "blockName");
    const prop = (schema.properties as Record<string, { enum?: string[] }>).blockName;
    expect(prop.enum).toEqual(["content", "footer"]);
  });

  it("returns the static schema unchanged when there is no focused page", () => {
    const schema = withBlockNameEnum(BASE, stateWith(null), "blockName");
    const prop = (schema.properties as Record<string, { enum?: string[] }>).blockName;
    expect(prop.enum).toBeUndefined();
  });

  it("does NOT emit an empty enum when the template has zero blocks", () => {
    const state = stateWith({ id: "p1", templateId: "t1", blockNames: [] });
    const schema = withBlockNameEnum(BASE, state, "blockName");
    const prop = (schema.properties as Record<string, { enum?: string[] }>).blockName;
    expect(prop.enum).toBeUndefined();
  });

  it("does not mutate the base schema", () => {
    const state = stateWith({ id: "p1", templateId: "t1", blockNames: ["content"] });
    withBlockNameEnum(BASE, state, "blockName");
    expect((BASE.properties.blockName as { enum?: string[] }).enum).toBeUndefined();
  });
});

describe("blockNotFoundError", () => {
  it("names the valid set + an inspect_page_render nextAction referencing the arg", () => {
    const r = blockNotFoundError({
      blockName: "hero",
      blockNames: ["content", "footer"],
      pageId: "p1",
      argName: "blockName",
    });
    expect(r.ok).toBe(false);
    expect(r.content).toContain('block "hero" does not exist');
    expect(r.content).toContain("content, footer");
    expect(r.nextAction?.tool).toBe("inspect_page_render");
    expect(r.nextAction?.reason).toContain("blockName");
  });
});
