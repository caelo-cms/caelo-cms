// SPDX-License-Identifier: MPL-2.0

/**
 * issue #251 (WS5) — the provider inputSchema is generated from the Zod
 * `schema` at registration, so the two can no longer drift.
 *
 * This suite proves equivalence BEFORE trusting the generated schema for the
 * four tools with drift/coercion history (F11/F12/F17 + #245):
 * `fork_placement_content`, `set_content_instance_values`, `offer_choices`,
 * `set_theme_tokens`. Each tool's PRE-DELETION hand-written schema is
 * embedded below as a fixture; we assert the registry's now-generated
 * `inputSchema` matches its property key set + required set + object shape.
 * A generic pass then asserts generation is robust (no throw, object schema)
 * for EVERY registered tool, so the remaining hand-written schemas can be
 * migrated later with confidence.
 */

import { describe, expect, it } from "bun:test";
import { generateInputSchema } from "../generate-input-schema.js";
import { createDefaultToolRegistry } from "../index.js";

const registry = createDefaultToolRegistry();

/** Property key set + required set from a JSON-schema object. */
function shapeOf(schema: unknown): { keys: string[]; required: string[]; strict: boolean } {
  const s = (schema ?? {}) as {
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: unknown;
    type?: string;
  };
  return {
    keys: Object.keys(s.properties ?? {}).sort(),
    required: [...(s.required ?? [])].sort(),
    strict: s.type === "object" && s.additionalProperties === false,
  };
}

/**
 * Pre-deletion hand-written inputSchemas — the equivalence baseline. If a
 * migrated tool's Zod schema ever changes its key set, this fixture makes the
 * regression loud instead of silently shipping a drifted provider schema.
 */
const HANDWRITTEN: Record<string, { keys: string[]; required: string[] }> = {
  fork_placement_content: {
    keys: ["blockName", "pageId", "position"],
    required: ["blockName", "pageId", "position"],
  },
  set_content_instance_values: {
    keys: ["displayName", "expectedVersion", "id", "purpose", "slug", "values"],
    required: ["id", "values"],
  },
  offer_choices: {
    keys: ["options", "question"],
    required: ["options", "question"],
  },
  set_theme_tokens: {
    keys: ["remove", "set", "themeSlug"],
    required: [],
  },
};

describe("generateInputSchema — migrated tools match their hand-written baseline", () => {
  for (const [name, baseline] of Object.entries(HANDWRITTEN)) {
    it(`${name}: generated inputSchema is key/required-equivalent to the deleted hand-written one`, () => {
      const tool = registry.get(name);
      expect(tool).toBeTruthy();
      const shape = shapeOf(tool?.inputSchema);
      expect(shape.keys).toEqual([...baseline.keys].sort());
      expect(shape.required).toEqual([...baseline.required].sort());
      expect(shape.strict).toBe(true);
    });
  }
});

describe("generateInputSchema — a Zod-valid sample round-trips", () => {
  // Each sample must parse under the tool's Zod schema AND only use keys the
  // generated provider schema advertises.
  const SAMPLES: Record<string, Record<string, unknown>> = {
    fork_placement_content: {
      pageId: "00000000-0000-4000-8000-000000000000",
      blockName: "header",
      position: 0,
    },
    set_content_instance_values: {
      id: "00000000-0000-4000-8000-000000000000",
      values: { hero_title: "Hi" },
    },
    offer_choices: {
      question: "Which layout?",
      options: [
        { key: "A", label: "Sidebar" },
        { key: "B", label: "Full width" },
      ],
    },
    set_theme_tokens: { set: { primaryColor: "#0a0a0a" } },
  };

  for (const [name, sample] of Object.entries(SAMPLES)) {
    it(`${name}: sample parses and uses only advertised keys`, () => {
      const tool = registry.get(name);
      expect(tool).toBeTruthy();
      expect(() => tool?.schema.parse(sample)).not.toThrow();
      const advertised = shapeOf(tool?.inputSchema).keys;
      for (const k of Object.keys(sample)) expect(advertised).toContain(k);
    });
  }
});

describe("generateInputSchema — robust across the whole catalogue", () => {
  it("generates an object JSON schema for every registered tool (future-migration safety)", () => {
    for (const tool of registry.list()) {
      const generated = generateInputSchema(tool.schema);
      expect(generated.type, `${tool.name} should generate an object schema`).toBe("object");
      // No leftover dialect marker on the provider-facing schema.
      expect(generated.$schema).toBeUndefined();
    }
  });
});
