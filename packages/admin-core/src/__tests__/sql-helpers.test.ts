// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { buildPatchSet, buildWhere } from "../sql-helpers.js";

/**
 * Light unit checks. Drizzle SQL fragments are nested and don't render to a
 * string outside an adapter — the integration tests in
 * content-{modules,pages,templates}.integration.test.ts exercise the actual
 * UPDATE / SELECT shapes against real Postgres.
 */

describe("buildPatchSet", () => {
  it("returns a non-empty SQL fragment when at least one field is defined", () => {
    const out = buildPatchSet({ display_name: "x", html: undefined });
    expect(out).toBeTruthy();
    // Smoke check that drizzle treated it as an SQL fragment object.
    expect(typeof out).toBe("object");
  });

  it("throws if every field is undefined", () => {
    expect(() => buildPatchSet({ display_name: undefined, html: undefined })).toThrow(
      /at least one field/,
    );
  });

  it("ignores explicitly undefined fields without including them", () => {
    // The handler-level test for this is the modules update integration test —
    // here we just confirm the helper does not throw on partial patches.
    expect(() => buildPatchSet({ display_name: "x" })).not.toThrow();
    expect(() => buildPatchSet({ html: "<p>x</p>", css: undefined })).not.toThrow();
  });
});

describe("buildWhere", () => {
  it("returns a fragment for an empty predicate list (callable in any sql template)", () => {
    const out = buildWhere([]);
    expect(out).toBeTruthy();
    // Composes cleanly when interpolated.
    const composed = sql`SELECT 1 ${out}`;
    expect(composed).toBeTruthy();
  });

  it("returns a fragment for a non-empty predicate list", () => {
    const out = buildWhere([sql`deleted_at IS NULL`, sql`locale = ${"en"}`]);
    expect(out).toBeTruthy();
    const composed = sql`SELECT 1 FROM pages ${out}`;
    expect(composed).toBeTruthy();
  });
});
