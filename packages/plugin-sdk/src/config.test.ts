// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { DEFAULT_EMBEDDING_MODEL_ID } from "@caelo-cms/shared/embedding-models";
import {
  applyConfigPatch,
  checkConfig,
  configDefaults,
  configLeaves,
  configPatchSchema,
  configValueSchema,
  entityConfigSchema,
  entityConfigValue,
  mapValue,
  type PluginConfigSchema,
  parseConfigSchema,
  patchedLeaves,
} from "./config.js";

const SCHEMA: PluginConfigSchema = parseConfigSchema({
  semantic: {
    type: "bool",
    label: "Semantic search",
    description: "Also find pages by meaning.",
    effect: "rebuild",
    default: false,
  },
  results: {
    type: "int",
    label: "Results",
    description: "Hits per page.",
    effect: "query",
    min: 1,
    max: 50,
    default: 10,
  },
  ranking: {
    type: "group",
    label: "Ranking",
    description: "How hits are ordered.",
    fields: {
      weights: {
        type: "map",
        label: "Page type weights",
        description: "Boost per page type.",
        effect: "query",
        keys: "pageType",
        value: {
          type: "number",
          label: "Weight",
          description: "Multiplier.",
          effect: "query",
          min: 0,
          max: 5,
          default: 1,
        },
        default: { product: 2 },
      },
      mode: {
        type: "enum",
        label: "Mode",
        description: "Fusion mode.",
        effect: "query",
        options: [
          { value: "words", label: "Words" },
          { value: "hybrid", label: "Hybrid" },
        ],
        default: "words",
      },
    },
  },
  synonyms: {
    type: "listRef",
    label: "Synonyms",
    description: "Visible synonym list.",
    effect: "query",
    listType: "site-search-synonyms",
    default: null,
  },
  daily_cap: {
    type: "int",
    label: "Daily cap",
    description: "Cost cap.",
    effect: "none",
    gate: "approval",
    min: 0,
    max: 1000,
    default: 100,
  },
});

describe("config schema", () => {
  it("fills gate and scope defaults and lists every leaf with its path", () => {
    expect(configLeaves(SCHEMA).map((l) => l.path)).toEqual([
      "semantic",
      "results",
      "ranking.weights",
      "ranking.mode",
      "synonyms",
      "daily_cap",
    ]);
    expect(configLeaves(SCHEMA)[0]?.field.gate).toBe("routine");
    expect(configLeaves(SCHEMA)[0]?.field.scope).toBe("release");
  });

  it("stores defaults that validate against the value schema", () => {
    const defaults = configDefaults(SCHEMA);
    expect(defaults).toEqual({
      semantic: false,
      results: 10,
      ranking: { weights: { product: 2 }, mode: "words" },
      synonyms: null,
      daily_cap: 100,
    });
    expect(configValueSchema(SCHEMA).safeParse(defaults).success).toBe(true);
  });

  it("rejects out-of-range values, unknown options and unknown keys", () => {
    const v = configValueSchema(SCHEMA);
    const base = configDefaults(SCHEMA);
    expect(v.safeParse({ ...base, results: 51 }).success).toBe(false);
    expect(v.safeParse({ ...base, ranking: { weights: {}, mode: "fuzzy" } }).success).toBe(false);
    expect(v.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(v.safeParse({ ...base, synonyms: "not-a-uuid" }).success).toBe(false);
  });

  it("applies a merge patch: groups recursively, maps per key, null removes a key", () => {
    const base = configDefaults(SCHEMA);
    const patch = configPatchSchema(SCHEMA).parse({
      results: 20,
      ranking: { weights: { doc: 3, product: null } },
    });
    const next = applyConfigPatch(SCHEMA, base, patch);
    expect(next).toEqual({ ...base, results: 20, ranking: { weights: { doc: 3 }, mode: "words" } });
    expect(patchedLeaves(SCHEMA, patch).map((l) => l.path)).toEqual(["results", "ranking.weights"]);
    expect(configPatchSchema(SCHEMA).safeParse({ ranking: { weights: { doc: 9 } } }).success).toBe(
      false,
    );
  });

  it("reads a map key with the value default when it is unset", () => {
    const weights = (SCHEMA.ranking as { fields: PluginConfigSchema }).fields.weights;
    if (weights?.type !== "map") throw new Error("map expected");
    expect(mapValue(weights, { product: 2 }, "product")).toBe(2);
    expect(mapValue(weights, { product: 2 }, "news")).toBe(1);
  });

  it("lints immediate scope with a visible effect, impossible bounds and invalid defaults", () => {
    const issues: string[] = [];
    checkConfig(
      parseConfigSchema({
        a: {
          type: "bool",
          label: "A",
          description: "A.",
          effect: "query",
          scope: "immediate",
          default: true,
        },
        b: {
          type: "int",
          label: "B",
          description: "B.",
          effect: "none",
          min: 5,
          max: 1,
          default: 3,
        },
        c: {
          type: "enum",
          label: "C",
          description: "C.",
          effect: "none",
          options: [
            { value: "x", label: "X" },
            { value: "y", label: "Y" },
          ],
          default: "z",
        },
      }),
      {
        module: {
          mode: {
            type: "int",
            label: "M",
            description: "M.",
            effect: "pages",
            min: 0,
            max: 3,
            default: 9,
          },
        },
      },
      (path, message) => issues.push(`${path.join(".")}: ${message}`),
    );
    expect(issues.some((i) => i.startsWith("config.a") && i.includes("immediate"))).toBe(true);
    expect(issues.some((i) => i.startsWith("config.b") && i.includes("above max"))).toBe(true);
    expect(issues.some((i) => i.startsWith("config.c.default"))).toBe(true);
    expect(issues.some((i) => i.startsWith("entityConfig.module.mode.default"))).toBe(true);
  });

  it("takes only a model of the core catalog, or null, for a catalogModel leaf (#1650)", () => {
    const model = parseConfigSchema({
      model: {
        type: "catalogModel",
        purpose: "embedding",
        label: "Model",
        description: "The embedding model.",
        effect: "rebuild",
        default: DEFAULT_EMBEDDING_MODEL_ID,
      },
    });
    const values = configValueSchema(model);
    expect(values.safeParse({ model: DEFAULT_EMBEDDING_MODEL_ID }).success).toBe(true);
    expect(values.safeParse({ model: null }).success).toBe(true);
    expect(values.safeParse({ model: "jina-embeddings-v3" }).success).toBe(false);
    const issues: string[] = [];
    checkConfig(
      parseConfigSchema({
        model: {
          type: "catalogModel",
          purpose: "embedding",
          label: "Model",
          description: "The embedding model.",
          effect: "rebuild",
          default: "a-plugin-shipped-model",
        },
      }),
      undefined,
      (path, message) => issues.push(`${path.join(".")}: ${message}`),
    );
    expect(issues).toEqual([
      expect.stringMatching(
        /^config\.model\.default: default "a-plugin-shipped-model" is not a model of the core catalog/,
      ),
    ]);
  });

  it("validates entity config and reads unset fields as their defaults", () => {
    const fields = {
      mode: parseConfigSchema({
        mode: {
          type: "enum",
          label: "Search mode",
          description: "How this module counts.",
          effect: "pages",
          options: [
            { value: "auto", label: "Auto" },
            { value: "never", label: "Never" },
          ],
          default: "auto",
        },
      }).mode,
    } as Record<string, never>;
    expect(entityConfigSchema(fields).safeParse({ mode: "never" }).success).toBe(true);
    expect(entityConfigSchema(fields).safeParse({ mode: "sometimes" }).success).toBe(false);
    expect(entityConfigValue(fields, undefined)).toEqual({ mode: "auto" });
    expect(entityConfigValue(fields, { mode: null })).toEqual({ mode: "auto" });
  });
});
