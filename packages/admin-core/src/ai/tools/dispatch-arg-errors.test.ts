// SPDX-License-Identifier: MPL-2.0

/**
 * Argument-rejection messages must be repairable IN THE SAME TURN.
 *
 * The failure that motivated this: a live migrate chat called `offer_choices`
 * with `{}` twice in a row. The tool is DEFERRED (Anthropic tool search), so
 * the model had its name but not its schema, and the rejection listed only key
 * NAMES — which cannot repair a nested argument. The model had no way to learn
 * that `options` is an array of `{key, label}` objects, so it re-sent nothing.
 *
 * Two tiers are pinned here:
 *   - every rejection describes the arguments (type + required), not just names;
 *   - a call that carried NOTHING additionally gets the full JSON Schema, since
 *     an empty call is the signature of a definition that was never loaded.
 */

import { describe, expect, it } from "bun:test";
import type { ExecutionContext } from "@caelo-cms/shared";
import { z } from "zod";

import { ToolRegistry } from "./dispatch.js";

const CTX: ExecutionContext = { actorId: "a", actorKind: "ai", requestId: "r" };

/** Mirrors offer_choices: a scalar plus an array of objects. */
function registryWithChoiceTool(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    name: "ask_operator",
    description: "asks the operator to choose",
    schema: z.object({
      question: z.string(),
      options: z.array(z.object({ key: z.string(), label: z.string() })).min(2),
    }),
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "the question to put to the operator" },
        options: {
          type: "array",
          minItems: 2,
          items: {
            type: "object",
            properties: { key: { type: "string" }, label: { type: "string" } },
            required: ["key", "label"],
          },
        },
      },
      required: ["question", "options"],
      additionalProperties: false,
    },
    handler: async () => ({ ok: true, content: "asked" }),
  } as never);
  return tools;
}

describe("tool argument rejection", () => {
  it("hands back the full schema when the call carried no arguments", async () => {
    const res = await (registryWithChoiceTool() as ToolRegistry).dispatch("ask_operator", {}, CTX);

    expect(res.ok).toBe(false);
    const msg = res.content;
    // States what happened and hands over the schema — no instruction about
    // what to do with it. That call is the model's to make.
    expect(msg).toContain("NO arguments");
    expect(msg).not.toMatch(/you (do not|don't) need to/i);
    // The nested shape — the part a key list can never convey.
    expect(msg).toContain("```json");
    expect(msg).toContain('"minItems": 2');
    expect(msg).toContain('"key"');
    expect(msg).toContain('"label"');
  });

  it("describes each argument's type and requiredness, not just its name", async () => {
    const res = await (registryWithChoiceTool() as ToolRegistry).dispatch(
      "ask_operator",
      { question: "which?" },
      CTX,
    );

    expect(res.ok).toBe(false);
    expect(res.content).toContain("`question` (string, required)");
    expect(res.content).toContain("`options` (array, required)");
    // The schema's own blurb rides along — it is the best description we have.
    expect(res.content).toContain("the question to put to the operator");
  });

  it("omits the full schema when arguments were supplied", async () => {
    // A partial call proves the model HAS the definition and simply got a
    // field wrong; pasting the whole schema would be tokens for nothing.
    const res = await (registryWithChoiceTool() as ToolRegistry).dispatch(
      "ask_operator",
      { question: "which?", options: [] },
      CTX,
    );

    expect(res.ok).toBe(false);
    expect(res.content).not.toContain("```json");
    expect(res.content).not.toContain("NO arguments");
  });

  it("skips the full schema for an oversized definition even on an empty call", async () => {
    // Guard on the paste: a schema this large belongs to a tool the model
    // almost certainly has loaded, and dumping it costs more than it repairs.
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 400; i++) {
      properties[`field_${i}`] = { type: "string", description: "x".repeat(40) };
    }
    const tools = new ToolRegistry();
    tools.register({
      name: "huge_tool",
      description: "many arguments",
      schema: z.object({ field_0: z.string() }),
      inputSchema: {
        type: "object",
        properties,
        required: ["field_0"],
        additionalProperties: false,
      },
      handler: async () => ({ ok: true, content: "ok" }),
    } as never);

    const res = await tools.dispatch("huge_tool", {}, CTX);

    expect(res.ok).toBe(false);
    expect(res.content).not.toContain("```json");
    // The per-argument summary still lands — it is bounded by construction.
    expect(res.content).toContain("`field_0` (string, required)");
  });
});
