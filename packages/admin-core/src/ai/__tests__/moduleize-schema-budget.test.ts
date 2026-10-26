// SPDX-License-Identifier: MPL-2.0

/**
 * Anthropic's structured output refuses a schema with more than 24
 * optional parameters ("Schemas contains too many optional parameters …
 * limit: 24") — every moduleize call then fails before the model runs.
 * PR #1121's e2e-livedit run hit exactly that when the module-tool field
 * schema (bindings, sources, min / max) was reused for moduleize. This
 * pins the budget on the schema moduleize actually sends.
 */

import { describe, expect, it } from "bun:test";
import { MODULEIZE_JSON_SCHEMA } from "../moduleize.js";

/** Optional properties across the whole schema, every occurrence counted. */
function countOptional(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((n, x) => n + countOptional(x), 0);
  if (typeof node !== "object" || node === null) return 0;
  const o = node as Record<string, unknown>;
  let n = 0;
  if (o.properties && typeof o.properties === "object") {
    const required = new Set(Array.isArray(o.required) ? (o.required as string[]) : []);
    for (const [k, v] of Object.entries(o.properties as Record<string, unknown>)) {
      if (!required.has(k)) n += 1;
      n += countOptional(v);
    }
  }
  for (const key of ["items", "anyOf", "oneOf", "allOf"] as const) {
    if (o[key] !== undefined) n += countOptional(o[key]);
  }
  return n;
}

describe("moduleize structured-output schema", () => {
  it("stays within the provider's 24-optional-parameter limit", () => {
    expect(countOptional(MODULEIZE_JSON_SCHEMA)).toBeLessThanOrEqual(24);
  });
});
