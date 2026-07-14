// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildPatchSet, buildWhere, jsonbParam } from "../sql-helpers.js";

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

/**
 * Issue #68 — pin the write semantic so a future bun:SQL / drizzle version can't
 * silently reintroduce the double-encoding bug. We render the fragment through
 * the Postgres dialect and assert both the SQL text and the bound param: the
 * value MUST go through `::text` before `::jsonb` (so Postgres parses the JSON
 * into a structured value), never a bare `$1::jsonb` (which would store a
 * jsonb-string scalar).
 */
describe("jsonbParam (issue #68 double-encoding guard)", () => {
  const dialect = new PgDialect();
  const render = (value: unknown) => dialect.sqlToQuery(sql`SELECT ${jsonbParam(value)} AS v`);

  it("casts an object through ::text before ::jsonb and binds the stringified value", () => {
    const q = render({ a: 1, nested: { b: [2, 3] } });
    expect(q.sql).toBe("SELECT ($1::text)::jsonb AS v");
    expect(q.params).toEqual([JSON.stringify({ a: 1, nested: { b: [2, 3] } })]);
    // The bare, double-encoding form must never appear.
    expect(q.sql).not.toContain("$1::jsonb");
  });

  it("casts an array through ::text before ::jsonb", () => {
    const q = render([{ name: "x", kind: "text", label: "x" }]);
    expect(q.sql).toBe("SELECT ($1::text)::jsonb AS v");
    expect(q.params).toEqual(['[{"name":"x","kind":"text","label":"x"}]']);
  });

  it("binds SQL NULL (not a jsonb-string) for null and undefined", () => {
    for (const v of [null, undefined]) {
      const q = render(v);
      expect(q.sql).toBe("SELECT NULL AS v");
      expect(q.params).toEqual([]);
    }
  });

  it("treats a string argument as already-serialized JSON payload (no double-stringify)", () => {
    // e.g. a jsonb value read back from the DB and re-inserted on a fork path.
    const q = render('{"x":9}');
    expect(q.sql).toBe("SELECT ($1::text)::jsonb AS v");
    expect(q.params).toEqual(['{"x":9}']);
  });
});
