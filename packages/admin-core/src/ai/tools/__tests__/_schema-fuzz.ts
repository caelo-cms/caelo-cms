// SPDX-License-Identifier: MPL-2.0

/**
 * Test helpers for the model-facing schema compaction: the real catalogue's
 * schemas before compaction, and a deterministic random-instance generator
 * that walks a JSON Schema and produces candidate tool arguments.
 *
 * The generator is deliberately simple: it picks from a pool of realistic
 * strings (ids, `caelo:` references, paths, slugs) that satisfy the
 * catalogue's patterns, and lets the ORIGINAL schema's validator decide which
 * candidates count. Only candidates valid under the original are used, so a
 * candidate the generator got wrong never produces a false failure.
 */

import { spyOn } from "bun:test";
import { type ToolInputSchema, ToolRegistry } from "../dispatch.js";
import { generateInputSchema } from "../generate-input-schema.js";
import { createDefaultToolRegistry } from "../index.js";

/** A tool's provider-facing schema before and after compaction. */
export interface SchemaPair {
  readonly name: string;
  readonly original: ToolInputSchema;
  readonly compact: ToolInputSchema;
}

/** Every default-registry tool's schema, as resolved before and after compaction. */
export function catalogueSchemaPairs(): SchemaPair[] {
  const spy = spyOn(ToolRegistry.prototype, "register");
  try {
    const registry = createDefaultToolRegistry();
    return spy.mock.calls.map(([tool]) => ({
      name: tool.name,
      original: tool.inputSchema ?? generateInputSchema(tool.schema),
      compact: registry.get(tool.name)?.inputSchema as ToolInputSchema,
    }));
  } finally {
    spy.mockRestore();
  }
}

const UUID = "3f2b8c1e-4a5d-4e6f-8a7b-1c2d3e4f5a6b";
/** A content hash, as the font tools take it. */
export const SHA256 = "ab".repeat(32);
const STRING_POOL = [
  "a",
  "a_b",
  "hero_title",
  "a-b",
  "news",
  UUID,
  `caelo:term/${UUID}/${UUID}`,
  `caelo:page/${UUID}`,
  `caelo:list/${UUID}`,
  `caelo:media/${UUID}`,
  "published_desc",
  "prop_desc:a",
  "2026-10-26T10:00:00Z",
  "2026-10-26",
  "#aabbcc",
  "/about",
  "https://example.com/",
  "a@example.com",
  "text",
  "en",
  "de-DE",
  "1rem",
  "Hello",
  SHA256,
];

type Node = Record<string, unknown>;

/** A seeded linear congruential generator (reproducible across runs). */
export function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/** Generates candidate instances of `root`; `undefined` = gave up on this draw. */
export function instanceGenerator(root: ToolInputSchema, rand: () => number) {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;

  const resolve = (schema: unknown): Node | undefined => {
    if (typeof schema !== "object" || schema === null) return undefined;
    const ref = (schema as Node).$ref;
    if (typeof ref !== "string") return schema as Node;
    let target: unknown = root;
    for (const key of ref.replace(/^#\//, "").split("/")) target = (target as Node)[key];
    return resolve(target);
  };

  const gen = (input: unknown, depth: number): unknown => {
    const s = resolve(input);
    if (!s || depth > 7) return undefined;
    if (s.const !== undefined) return s.const;
    if (Array.isArray(s.enum)) return pick(s.enum);
    for (const key of ["oneOf", "anyOf"])
      if (Array.isArray(s[key])) return gen(pick(s[key] as unknown[]), depth + 1);
    if (Array.isArray(s.allOf))
      return Object.assign({}, ...(s.allOf as unknown[]).map((x) => gen(x, depth + 1)));
    const type = Array.isArray(s.type) ? pick(s.type) : s.type;
    if (type === "null") return null;
    if (type === "boolean") return rand() < 0.5;
    if (type === "integer" || type === "number") {
      const lo =
        typeof s.minimum === "number"
          ? s.minimum
          : typeof s.exclusiveMinimum === "number"
            ? s.exclusiveMinimum + 1
            : 0;
      const hi = typeof s.maximum === "number" ? s.maximum : lo + 10;
      return Math.floor(lo + rand() * Math.min(hi - lo + 1, 20));
    }
    if (type === "string") return genString(s);
    if (type === "array") return genArray(s, depth);
    if (type === "object" || s.properties) return genObject(s, depth);
    return pick(["x", 1, true]);
  };

  const genString = (s: Node): string | undefined => {
    if (s.format === "uuid") return UUID;
    if (s.format === "date-time") return "2026-10-26T10:00:00Z";
    if (s.format === "email") return "a@example.com";
    if (s.format === "uri") return "https://example.com/";
    const pattern = typeof s.pattern === "string" ? new RegExp(s.pattern, "u") : null;
    const min = typeof s.minLength === "number" ? s.minLength : 0;
    const max = typeof s.maxLength === "number" ? s.maxLength : Number.POSITIVE_INFINITY;
    const fits = STRING_POOL.filter(
      (v) => (!pattern || pattern.test(v)) && v.length >= min && v.length <= max,
    );
    return fits.length > 0 ? pick(fits) : undefined;
  };

  const genArray = (s: Node, depth: number): unknown[] | undefined => {
    const minItems = typeof s.minItems === "number" ? s.minItems : 0;
    const n = Math.max(minItems, Math.floor(rand() * 3));
    const count = Math.min(n, typeof s.maxItems === "number" ? s.maxItems : n);
    const out: unknown[] = [];
    for (let i = 0; i < count; i++) {
      const v = gen(s.items, depth + 1);
      if (v === undefined) return undefined;
      out.push(v);
    }
    return out;
  };

  const genObject = (s: Node, depth: number): Node | undefined => {
    const out: Node = {};
    const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    for (const [key, prop] of Object.entries((s.properties as Node | undefined) ?? {})) {
      if (!required.has(key) && rand() >= 0.6) continue;
      const v = gen(prop, depth + 1);
      if (v !== undefined) out[key] = v;
      else if (required.has(key)) return undefined;
    }
    const extra = s.additionalProperties;
    if (
      typeof extra === "object" &&
      extra !== null &&
      Object.keys(out).length === 0 &&
      rand() < 0.5
    ) {
      const v = gen(extra, depth + 1);
      if (v !== undefined) out[pick(["a", "hero_title", "news"])] = v;
    }
    return out;
  };

  return () => gen(root, 0);
}
