// SPDX-License-Identifier: MPL-2.0

/**
 * #644 — unit tests for `toolArgsProblem`, the check that keeps an AI
 * tool call with misnamed arguments from reaching a plugin handler (which
 * reads its args by cast and would carry the `undefined` into SQL).
 */

import { describe, expect, it } from "bun:test";
import { toolArgsProblem } from "./dispatch.js";

const translateVariant = {
  name: "translate_variant",
  inputJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["variantPageId"],
    properties: {
      variantPageId: { type: "string", format: "uuid" },
      mode: { type: "string", enum: ["auto", "full", "update"] },
    },
  },
};

describe("toolArgsProblem", () => {
  it("accepts arguments that match the schema", () => {
    expect(
      toolArgsProblem(translateVariant, { variantPageId: crypto.randomUUID(), mode: "full" }),
    ).toBeNull();
  });

  it("names the accepted fields when a required one is missing under another key", () => {
    const problem = toolArgsProblem(translateVariant, { pageId: crypto.randomUUID() });
    expect(problem).toContain('InvalidToolInput: "translate_variant"');
    expect(problem).toContain("variantPageId");
    expect(problem).toContain("pageId");
    expect(problem).toContain("It accepts: variantPageId (required), mode.");
  });

  it("refuses a wrong value type", () => {
    expect(toolArgsProblem(translateVariant, { variantPageId: "not-a-uuid" })).toContain(
      "InvalidToolInput",
    );
  });

  it("describes a tool without properties", () => {
    expect(toolArgsProblem({ name: "t", inputJsonSchema: { type: "object" } }, 3)).toContain(
      "It accepts: no arguments.",
    );
  });
});
