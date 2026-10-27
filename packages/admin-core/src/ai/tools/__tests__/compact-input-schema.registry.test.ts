// SPDX-License-Identifier: MPL-2.0

/**
 * The model-facing schema compaction over the REAL tool catalogue:
 *
 * 1. Superset: random arguments valid under a tool's original schema stay
 *    valid under its compact schema — the compaction never blocks a call
 *    the Zod parse would accept.
 * 2. Information preservation: every property name, enum/const value and
 *    domain pattern of the original still reaches the model — as schema
 *    structure, inside the combined pattern, or in a description.
 * 3. No tool's schema grows.
 */

import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { catalogueSchemaPairs, instanceGenerator, SHA256, seededRandom } from "./_schema-fuzz.js";

const pairs = catalogueSchemaPairs();

function validator(schema: object) {
  const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

/**
 * Hand-written arguments, for tools the generator could not satisfy before
 * its pool carried a content hash (any new tool the generator cannot sample
 * belongs here): each must be valid under the original and stay valid.
 */
const FONT_ID = "3f2b8c1e-4a5d-4e6f-8a7b-1c2d3e4f5a6b";
const HAND_WRITTEN_CASES: Record<string, readonly unknown[]> = {
  inspect_font: [{ id: FONT_ID, sha256: SHA256 }],
  preview_typography: [
    { id: FONT_ID, sha256: SHA256, use: "web", text: "", formats: ["woff2"] },
    { id: FONT_ID, sha256: SHA256, use: "document", text: "Aa", formats: ["ttf", "otf"] },
  ],
};

const SAMPLES_PER_TOOL = 250;

describe("compact tool schemas accept everything the original accepted", () => {
  test("random valid arguments for every tool stay valid", () => {
    const rejected: string[] = [];
    const unsampled: string[] = [];
    for (const { name, original, compact } of pairs) {
      const isValidOriginal = validator(original);
      const isValidCompact = validator(compact);
      const next = instanceGenerator(original, seededRandom(name.length * 7919 + 1));
      let valid = 0;
      for (let i = 0; i < SAMPLES_PER_TOOL; i++) {
        const args = next();
        if (args === undefined || !isValidOriginal(args)) continue;
        valid++;
        if (!isValidCompact(args)) {
          rejected.push(
            `${name}: ${JSON.stringify(args).slice(0, 300)} ${JSON.stringify(isValidCompact.errors)}`,
          );
        }
      }
      if (valid === 0) unsampled.push(name);
    }
    expect(rejected).toEqual([]);
    // A tool the generator cannot sample is only acceptable when its schema
    // is untouched by the compaction or it has hand-written cases.
    const uncovered = unsampled.filter((name) => {
      const pair = pairs.find((p) => p.name === name);
      const unchanged = JSON.stringify(pair?.original) === JSON.stringify(pair?.compact);
      return !unchanged && !(name in HAND_WRITTEN_CASES);
    });
    expect(uncovered).toEqual([]);
  });

  test("hand-written arguments for unsampled tools stay valid", () => {
    for (const [name, cases] of Object.entries(HAND_WRITTEN_CASES)) {
      const pair = pairs.find((p) => p.name === name);
      expect(pair).toBeDefined();
      if (!pair) continue;
      const isValidOriginal = validator(pair.original);
      const isValidCompact = validator(pair.compact);
      for (const args of cases) {
        expect({ name, args, original: isValidOriginal(args) }).toEqual({
          name,
          args,
          original: true,
        });
        expect({ name, args, compact: isValidCompact(args) }).toEqual({
          name,
          args,
          compact: true,
        });
      }
    }
  });
});

const SELF_DESCRIBING_FORMATS = new Set(["uuid", "date-time", "date", "email", "uri"]);

/**
 * The facts a model needs from a schema: property names, allowed values and
 * domain patterns (a regex Zod adds next to a format is not one). `ext`
 * internals are exempt: the compaction deliberately reduces that rarely used
 * escape hatch to `{ type: "object" }`.
 */
function facts(node: unknown, out = new Set<string>(), underExt = false): Set<string> {
  if (Array.isArray(node)) {
    for (const v of node) facts(v, out, underExt);
  } else if (typeof node === "object" && node !== null) {
    const n = node as Record<string, unknown>;
    if (!underExt) {
      if (typeof n.properties === "object" && n.properties !== null)
        for (const k of Object.keys(n.properties)) out.add(`prop\u0000${k}`);
      if (Array.isArray(n.enum)) for (const v of n.enum) out.add(`val\u0000${String(v)}`);
      if ("const" in n && (typeof n.const !== "object" || n.const === null))
        out.add(`val\u0000${String(n.const)}`);
      if (typeof n.pattern === "string" && !SELF_DESCRIBING_FORMATS.has(String(n.format)))
        out.add(`pat\u0000${n.pattern}`);
    }
    for (const [k, v] of Object.entries(n)) facts(v, out, underExt || k === "ext");
  }
  return out;
}

describe("compact tool schemas keep what the model needs to know", () => {
  test("every property name, allowed value and domain pattern survives", () => {
    const lost: string[] = [];
    for (const { name, original, compact } of pairs) {
      const kept = facts(compact);
      const blob = JSON.stringify(compact);
      for (const fact of facts(original)) {
        if (kept.has(fact)) continue;
        const [kind, value = ""] = fact.split("\u0000");
        const inText =
          kind === "pat"
            ? blob.includes(value.slice(1, -1)) ||
              blob.includes(JSON.stringify(value).slice(1, -1)) ||
              blob.includes(JSON.stringify(value.slice(1, -1)).slice(1, -1))
            : blob.includes(`\`${value}\``) || blob.includes(value);
        if (!inText) lost.push(`${name}: ${kind} ${value}`);
      }
    }
    expect(lost).toEqual([]);
  });

  test("no tool's schema grows", () => {
    const grown = pairs
      .filter((p) => JSON.stringify(p.compact).length > JSON.stringify(p.original).length)
      .map((p) => p.name);
    expect(grown).toEqual([]);
  });
});
