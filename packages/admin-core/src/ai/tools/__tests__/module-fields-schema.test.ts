// SPDX-License-Identifier: MPL-2.0

/**
 * Drift guard (issue #106 follow-up). The step-13 footer bug was a silent
 * divergence between a tool's hand-written JSON `fields` schema (what the
 * provider generates against) and the Zod `moduleFieldSchema` validator
 * (what actually runs). The fix deduped the JSON schema into
 * `_module-fields-schema.ts`, but nothing pinned its `kind` enum to the
 * canonical `MODULE_FIELD_KINDS` set. This test fails the moment the two
 * fall out of lockstep — catching that regression class at unit-test time
 * instead of in a live e2e run.
 */

import { MODULE_FIELD_KINDS } from "@caelo-cms/shared";
import { describe, expect, it } from "bun:test";
import { MODULE_FIELDS_JSON_SCHEMA } from "../_module-fields-schema.js";

/** Narrow the `Record<string, unknown>` schema to the bits we assert on. */
interface FieldsArraySchema {
  type: string;
  items: {
    type: string;
    additionalProperties: boolean;
    required: string[];
    properties: { kind: { type: string; enum: string[] } };
  };
}

describe("MODULE_FIELDS_JSON_SCHEMA — provider schema mirrors the Zod validator", () => {
  const schema = MODULE_FIELDS_JSON_SCHEMA as unknown as FieldsArraySchema;
  const item = schema.items;

  it("is an array of objects", () => {
    expect(schema.type).toBe("array");
    expect(item.type).toBe("object");
  });

  it("kind enum set-equals the canonical MODULE_FIELD_KINDS", () => {
    const fromJson = [...item.properties.kind.enum].sort();
    const fromZod = [...MODULE_FIELD_KINDS].sort();
    // Set-equality both ways so neither a missing nor an extra kind slips
    // through (a missing `link-list` is exactly the footer regression).
    expect(fromJson).toEqual(fromZod);
  });

  it("declares the same required keys + strictness as moduleFieldSchema", () => {
    expect([...item.required].sort()).toEqual(["kind", "label", "name"]);
    expect(item.additionalProperties).toBe(false);
  });
});
