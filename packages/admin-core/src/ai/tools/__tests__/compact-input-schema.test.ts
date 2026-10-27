// SPDX-License-Identifier: MPL-2.0

import { describe, expect, test } from "bun:test";
import type { ExecutionContext } from "@caelo-cms/shared";
import { z } from "zod";
import { compactInputSchema } from "../compact-input-schema.js";
import { type ToolContext, type ToolInputSchema, ToolRegistry } from "../dispatch.js";
import { generateInputSchema } from "../generate-input-schema.js";
import { normalizeToolArgs } from "../normalize-args.js";

const MAX_SAFE = 9007199254740991;
const compact = (schema: Record<string, unknown>) => compactInputSchema(schema as ToolInputSchema);

describe("discriminated unions flatten into one object", () => {
  const union = {
    oneOf: [
      {
        type: "object",
        description: "A text field.",
        properties: {
          type: { type: "string", const: "text" },
          name: { type: "string", description: "Field name." },
          max: { type: "integer", maximum: 100 },
          format: { type: "string", enum: ["plain", "rich"] },
        },
        required: ["type", "name", "max"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: { type: "string", const: "select" },
          name: { type: "string", description: "Field name." },
          max: { type: "integer", maximum: 10 },
          options: { type: "array", items: { type: "string" } },
          format: { type: "string", enum: ["list", "radio"] },
        },
        required: ["type", "name", "options"],
        additionalProperties: false,
      },
    ],
  };
  const out = compact(union) as {
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties?: boolean;
    oneOf?: unknown;
  };

  test("the discriminator becomes an enum carrying each branch's description", () => {
    expect(out.oneOf).toBeUndefined();
    expect(out.properties.type).toEqual({
      type: "string",
      enum: ["text", "select"],
      description: "`text`: A text field.",
    });
  });

  test("shared properties appear once; required-in-all stays required", () => {
    expect(out.properties.name).toEqual({ type: "string", description: "Field name." });
    expect(out.required).toEqual(["type", "name"]);
    expect(out.additionalProperties).toBe(false);
  });

  test("variant-specific requirements and membership move into the description", () => {
    expect(out.properties.max?.description).toContain("Required when `type`: `text`.");
    expect(out.properties.options?.description).toBe("Required when `type`: `select`.");
  });

  test("differing bounds widen with a per-variant note", () => {
    expect(out.properties.max?.maximum).toBe(100);
    expect(out.properties.max?.description).toContain("`text` <= 100, `select` <= 10");
  });

  test("differing enums leave the schema but stay in the description", () => {
    expect(out.properties.format?.enum).toBeUndefined();
    expect(out.properties.format?.type).toBe("string");
    expect(out.properties.format?.description).toBe(
      "`text`: `plain`|`rich`; `select`: `list`|`radio`.",
    );
  });

  test("a property in only some branches says which", () => {
    const partial = compact({
      anyOf: [
        { type: "object", properties: { kind: { const: "a" }, x: { type: "string" } } },
        { type: "object", properties: { kind: { const: "b" } } },
      ],
    }) as { properties: Record<string, Record<string, unknown>> };
    expect(partial.properties.x).toEqual({ type: "string", description: "For `kind`: `a`." });
  });

  test("additionalProperties: false survives only when every branch had it", () => {
    const mixed = compact({
      oneOf: [
        { type: "object", properties: { k: { const: "a" } }, additionalProperties: false },
        { type: "object", properties: { k: { const: "b" } } },
      ],
    });
    expect(mixed.additionalProperties).toBeUndefined();
  });

  test("a union without a unique discriminator is left alone", () => {
    const noDisc = {
      oneOf: [
        { type: "object", properties: { a: { type: "string" } } },
        { type: "object", properties: { b: { type: "string" } } },
      ],
    };
    expect(compact(noDisc)).toEqual(noDisc);
    const dup = {
      oneOf: [
        { type: "object", properties: { k: { const: "a" } } },
        { type: "object", properties: { k: { const: "a" } } },
      ],
    };
    expect(compact(dup)).toEqual(dup);
  });

  test("a dropped `properties` takes its `additionalProperties: false` with it", () => {
    const out = compact({
      oneOf: [
        {
          type: "object",
          properties: {
            k: { const: "a" },
            v: {
              type: "object",
              properties: { x: { type: "string" } },
              additionalProperties: false,
            },
          },
        },
        {
          type: "object",
          properties: {
            k: { const: "b" },
            v: {
              type: "object",
              properties: { y: { type: "number" } },
              additionalProperties: false,
            },
          },
        },
      ],
    }) as { properties: { v: Record<string, unknown> } };
    // Keeping `additionalProperties: false` without the properties would reject {x} and {y}.
    expect(out.properties.v.properties).toBeUndefined();
    expect(out.properties.v.additionalProperties).toBeUndefined();
    expect(out.properties.v.description).toContain('`a`: properties `{"x":{"type":"string"}}`');
  });
});

describe("allOf of objects merges", () => {
  test("properties and required combine", () => {
    expect(
      compact({
        allOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { type: "object", properties: { b: { type: "number" } } },
        ],
      }),
    ).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    });
  });

  test("conflicting property schemas bail out", () => {
    const conflict = {
      allOf: [
        { type: "object", properties: { a: { type: "string" } } },
        { type: "object", properties: { a: { type: "number" } } },
      ],
    };
    expect(compact(conflict)).toEqual(conflict);
  });
});

describe("unions of plain strings become one pattern", () => {
  test("enum, const and anchored patterns combine into one anchored pattern", () => {
    const out = compact({
      description: "Sort order.",
      anyOf: [
        { type: "string", enum: ["published_desc", "title.asc"] },
        { type: "string", const: "a+b" },
        { type: "string", pattern: "^prop_(?:desc|asc):[a-z_]+$" },
      ],
    });
    expect(out).toEqual({
      description: "Sort order.",
      type: "string",
      pattern: "^(?:published_desc|title\\.asc|a\\+b|prop_(?:desc|asc):[a-z_]+)$",
    });
    const re = new RegExp(out.pattern as string, "u");
    for (const ok of ["published_desc", "title.asc", "a+b", "prop_asc:hero"])
      expect(re.test(ok)).toBe(true);
    for (const bad of ["titleXasc", "aab", "prop_up:x"]) expect(re.test(bad)).toBe(false);
  });

  test("an unanchored, top-level-alternating or unconstrained branch bails out", () => {
    for (const branch of [
      { type: "string", pattern: "^a|b$" },
      { type: "string", pattern: "a+" },
      { type: "string", pattern: "^a\\$" },
      { type: "string" },
    ]) {
      const node = { anyOf: [{ type: "string", const: "x" }, branch] };
      expect(compact(node)).toEqual(node);
    }
  });
});

describe("nullable unions become a type list", () => {
  test("anyOf [X, null] -> type [t, null]", () => {
    expect(
      compact({ description: "Max.", anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] }),
    ).toEqual({ description: "Max.", type: ["integer", "null"], minimum: 0 });
  });

  test("an enum or const on X gains null, so null stays accepted", () => {
    expect(compact({ anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }] })).toEqual({
      type: ["string", "null"],
      enum: ["a", "b", null],
    });
    expect(compact({ anyOf: [{ type: "null" }, { type: "string", const: "a" }] })).toEqual({
      type: ["string", "null"],
      enum: ["a", null],
    });
  });

  test("a nested union or an untyped X is left alone", () => {
    const nested = { anyOf: [{ $ref: "#/$defs/x" }, { type: "null" }] };
    expect(compact(nested)).toEqual(nested);
  });
});

describe("number and Zod artifacts", () => {
  test("MAX_SAFE bounds drop; integer exclusiveMinimum 0 becomes minimum 1", () => {
    expect(compact({ type: "integer", exclusiveMinimum: 0, maximum: MAX_SAFE })).toEqual({
      type: "integer",
      minimum: 1,
    });
    expect(compact({ type: "integer", minimum: -MAX_SAFE, maximum: 50 })).toEqual({
      type: "integer",
      maximum: 50,
    });
    expect(compact({ type: "number", exclusiveMinimum: 0 })).toEqual({
      type: "number",
      exclusiveMinimum: 0,
    });
  });

  test("a format drops its Zod regex; a domain pattern stays", () => {
    for (const format of ["uuid", "date-time", "date", "email", "uri"])
      expect(compact({ type: "string", format, pattern: "^x$" })).toEqual({
        type: "string",
        format,
      });
    expect(compact({ type: "string", pattern: "^caelo:page/.+$" })).toEqual({
      type: "string",
      pattern: "^caelo:page/.+$",
    });
  });

  test("$schema, trivial propertyNames and empty additionalProperties drop", () => {
    expect(
      compact({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        propertyNames: { type: "string" },
        additionalProperties: {},
      }),
    ).toEqual({ type: "object" });
    expect(compact({ type: "object", propertyNames: { type: "string", pattern: "^a$" } })).toEqual({
      type: "object",
      propertyNames: { type: "string", pattern: "^a$" },
    });
  });

  test("a property named ext shrinks to a bare object", () => {
    expect(
      compact({
        type: "object",
        properties: {
          ext: { type: "object", propertyNames: { type: "string", pattern: "^[a-z0-9-]+$" } },
        },
      }),
    ).toEqual({ type: "object", properties: { ext: { type: "object" } } });
  });
});

describe("property names are never mistaken for keywords", () => {
  test("properties named like keywords keep their schemas", () => {
    const schema = {
      type: "object",
      properties: {
        pattern: { type: "string", maxLength: 500 },
        format: { type: "string", enum: ["uuid"] },
        maximum: { type: "integer" },
        $schema: { type: "string" },
        $ref: { type: "string" },
        additionalProperties: {},
        propertyNames: { type: "string" },
        oneOf: { type: "string" },
        anyOf: { type: "boolean" },
        allOf: { type: "number" },
        enum: { type: "integer", enum: [301, 302] },
      },
      required: ["pattern", "$ref"],
    };
    expect(compact(schema)).toEqual(schema);
  });

  test("a properties map that holds `format` and `pattern` keeps both", () => {
    const schema = {
      type: "object",
      properties: { format: { type: "string" }, pattern: { type: "string" } },
    };
    expect(compact(schema)).toEqual(schema);
  });
});

describe("compaction is safe to run anywhere", () => {
  const sample = {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid", pattern: "^x$" },
      at: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    $defs: { node: { type: "integer", exclusiveMinimum: 0, maximum: MAX_SAFE } },
  };

  test("the input is not mutated", () => {
    const before = structuredClone(sample);
    compact(sample);
    expect(sample).toEqual(before);
  });

  test("it is idempotent and reaches $defs", () => {
    const once = compact(sample);
    expect(compact(once)).toEqual(once);
    expect((once.$defs as { node: unknown }).node).toEqual({ type: "integer", minimum: 1 });
  });
});

describe("ToolRegistry stores the compact schema; Zod stays the strict authority", () => {
  const schema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("page"), pageId: z.string().uuid() }).strict(),
    z.object({ kind: z.literal("count"), n: z.number().int().positive().nullable() }).strict(),
  ]);
  const base = { description: "test", handler: async () => ({ content: "ok" }) };

  test("a generated schema is compacted at registration", () => {
    const registry = new ToolRegistry();
    registry.register({ ...base, name: "t", schema } as never);
    const stored = registry.get("t")?.inputSchema as Record<string, unknown>;
    expect(stored).toEqual(compactInputSchema(generateInputSchema(schema)));
    expect(stored.oneOf ?? stored.anyOf).toBeUndefined();
    expect((stored.properties as Record<string, unknown>).kind).toEqual({
      type: "string",
      enum: ["page", "count"],
    });
    // The compact schema would let {kind:"page", n:1} through; the Zod parse does not.
    expect(registry.get("t")?.schema.safeParse({ kind: "page", n: 1 }).success).toBe(false);
  });

  test("a hand-written schema is compacted too", () => {
    const registry = new ToolRegistry();
    registry.register({
      ...base,
      name: "h",
      schema: z.object({}),
      inputSchema: {
        $schema: "x",
        type: "object",
        properties: { n: { type: "integer", maximum: MAX_SAFE } },
      },
    } as never);
    expect(registry.get("h")?.inputSchema).toEqual({
      type: "object",
      properties: { n: { type: "integer" } },
    });
  });

  test("arg normalization reaches into flattened unions and nullable type lists", () => {
    const registry = new ToolRegistry();
    registry.register({ ...base, name: "t", schema } as never);
    const inputSchema = registry.get("t")?.inputSchema;
    expect(normalizeToolArgs({ kind: "count", n: "3" }, inputSchema).args).toEqual({
      kind: "count",
      n: 3,
    });
    expect(normalizeToolArgs({ kind: "count", n: null }, inputSchema).args).toEqual({
      kind: "count",
      n: null,
    });
  });

  test("an argument error names a nullable field's type list and null choice", async () => {
    const registry = new ToolRegistry();
    registry.register({
      ...base,
      name: "o",
      schema: z.object({ order: z.enum(["asc", "desc"]).nullable() }).strict(),
    } as never);
    const ai: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-0000000000a1",
      actorKind: "ai",
      requestId: "r",
    };
    const result = await registry.dispatch("o", { order: "up" }, ai, {} as ToolContext);
    expect(result.ok).toBe(false);
    expect(result.content).toContain(
      "- `order` (string | null, required) (one of: asc | desc | null)",
    );
  });
});
