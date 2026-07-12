// SPDX-License-Identifier: MPL-2.0
/**
 * issue #251 (WS5) — provider-side encoding damage on tool args is
 * repaired at dispatch, guided by the declared inputSchema. Regression
 * classes from the searchviu mission: F17 (integer position arrived as
 * "2"), F12 (offer_choices options arrived as a JSON string), whole
 * args arriving JSON-encoded.
 */
import { describe, expect, it } from "bun:test";
import { normalizeToolArgs } from "../normalize-args.js";

const SCHEMA = {
  type: "object",
  properties: {
    pageId: { type: "string" },
    position: { type: "integer", minimum: 0 },
    ratio: { type: "number" },
    force: { type: "boolean" },
    options: {
      type: "array",
      items: {
        type: "object",
        properties: { key: { type: "string" }, weight: { type: "integer" } },
      },
    },
    meta: { type: "object", properties: { depth: { type: "integer" } } },
  },
};

describe("normalizeToolArgs", () => {
  it("coerces a stringified integer (F17: fork_placement_content position)", () => {
    const r = normalizeToolArgs({ pageId: "p", position: "2" }, SCHEMA);
    expect(r.args).toEqual({ pageId: "p", position: 2 });
    expect(r.coercedPaths).toEqual(["position"]);
  });

  it("parses a JSON-encoded array (F12: offer_choices options as string)", () => {
    const r = normalizeToolArgs({ options: '[{"key":"A","weight":"3"}]' }, SCHEMA);
    expect(r.args).toEqual({ options: [{ key: "A", weight: 3 }] });
    expect(r.coercedPaths).toContain("options");
  });

  it("parses whole-args-as-string and repairs leaves inside", () => {
    const r = normalizeToolArgs('{"position":"0","force":"true"}', SCHEMA);
    expect(r.args).toEqual({ position: 0, force: true });
    expect(r.coercedPaths[0]).toBe("(root)");
  });

  it("recurses into nested objects", () => {
    const r = normalizeToolArgs({ meta: '{"depth":"4"}' }, SCHEMA);
    expect(r.args).toEqual({ meta: { depth: 4 } });
  });

  it("leaves already-correct values and undeclared properties untouched", () => {
    const args = { pageId: "p", position: 3, extra: "5", ratio: 1.5 };
    const r = normalizeToolArgs(args, SCHEMA);
    expect(r.args).toEqual(args);
    expect(r.coercedPaths).toEqual([]);
  });

  it("never turns a non-integer string into an integer", () => {
    const r = normalizeToolArgs({ position: "2.5" }, SCHEMA);
    expect(r.args).toEqual({ position: "2.5" });
    expect(r.coercedPaths).toEqual([]);
  });

  it("keeps a plain string for a string-typed property even if numeric", () => {
    const r = normalizeToolArgs({ pageId: "123" }, SCHEMA);
    expect(r.args).toEqual({ pageId: "123" });
    expect(r.coercedPaths).toEqual([]);
  });
});
