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

import { describe, expect, it } from "bun:test";
import { MODULE_FIELD_KINDS } from "@caelo-cms/shared";
import {
  MODULE_FIELDS_JSON_SCHEMA,
  MODULE_META_JSON_SCHEMA_PROPS,
} from "../_module-fields-schema.js";

/**
 * Walk a JSON schema and collect the JSON-pointer path of every subschema
 * that is an EMPTY object `{}` (accepts any JSON value). Anthropic's
 * structured-output API (`output_config.format`, used by `generateObject`)
 * rejects these with "Empty schema ({}) ... is not supported".
 */
function emptySubschemaPaths(node: unknown, path = "$"): string[] {
  if (!node || typeof node !== "object") return [];
  const obj = node as Record<string, unknown>;
  const out: string[] = [];
  // A schema node with zero keys is the forbidden empty `{}`. Skip arrays
  // (they're value lists like `enum`, not schema nodes).
  if (!Array.isArray(node) && Object.keys(obj).length === 0) out.push(path);
  for (const [k, v] of Object.entries(obj)) {
    out.push(...emptySubschemaPaths(v, `${path}.${k}`));
    if (Array.isArray(v))
      v.forEach((el, i) => {
        out.push(...emptySubschemaPaths(el, `${path}.${k}[${i}]`));
      });
  }
  return out;
}

/** Narrow the `Record<string, unknown>` schema to the bits we assert on. */
interface FieldsArraySchema {
  type: string;
  items: {
    type: string;
    additionalProperties: boolean;
    required: string[];
    properties: {
      kind: { type: string; enum: string[] };
      allowedModuleTypes: { type: string; maxItems?: number; items: { pattern?: string } };
    };
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

  it("constrains allowedModuleTypes to mirror the Zod bound z.array(slugSchema).max(32)", () => {
    // Without this the provider could generate a non-slug or >32-entry
    // allowlist the Validator then rejects — the same provider-vs-Zod
    // divergence class as the footer bug.
    const amt = item.properties.allowedModuleTypes;
    expect(amt.type).toBe("array");
    expect(amt.maxItems).toBe(32);
    // items pattern must be the slug regex (so a non-slug entry can't be generated).
    expect(amt.items.pattern).toBe("^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$");
  });

  it("contains NO empty {} subschema (SDK structured-output compatibility)", () => {
    // Regression guard (2026-07 live e2e): moduleize moved to the SDK-native
    // structured-output path (provider.generateObject → Anthropic
    // output_config.format), which REJECTS an empty `{}` subschema. The
    // field `default` shipped as `{}` (accept-any) and failed EVERY
    // add_module-without-fields call. The old forced-tool path tolerated it;
    // generateObject does not. Fail here at unit time — the moduleize unit
    // tests mock the provider, so only this schema-shape check catches it.
    const full = {
      type: "object",
      properties: { fields: MODULE_FIELDS_JSON_SCHEMA, ...MODULE_META_JSON_SCHEMA_PROPS },
    };
    expect(emptySubschemaPaths(full)).toEqual([]);
  });
});
