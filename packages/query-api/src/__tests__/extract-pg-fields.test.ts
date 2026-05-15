// SPDX-License-Identifier: MPL-2.0

/**
 * v0.5.17 — unit tests for `extractPgFields` (errors.ts).
 *
 * The function lifts Postgres structured fields out of the throw chain
 * the SQL drivers produce. Drizzle wraps Bun.SQL which wraps the
 * wire-level PG error; the fields can show up at any level. The
 * adapter's catch block uses this to populate `HandlerError.pgDetail`
 * so `describeError` can render structured reasons instead of
 * truncated SQL text.
 */

import { describe, expect, it } from "bun:test";
import { extractPgFields } from "../errors.js";

describe("extractPgFields", () => {
  it("returns null for non-objects", () => {
    expect(extractPgFields(null)).toBeNull();
    expect(extractPgFields(undefined)).toBeNull();
    expect(extractPgFields("Failed query: …")).toBeNull();
    expect(extractPgFields(42)).toBeNull();
  });

  it("returns null when no PG fields present anywhere in the chain", () => {
    expect(extractPgFields(new Error("plain error"))).toBeNull();
    expect(extractPgFields({ message: "thrown from app code" })).toBeNull();
  });

  it("extracts fields directly on the error (bun-postgres shape)", () => {
    const err = {
      code: "23503",
      detail: "Key (page_id)=(abc) is not present in table 'pages'.",
      constraint: "page_snapshots_page_id_fkey",
      table: "page_snapshots",
      message: "Failed query: INSERT INTO page_snapshots …",
    };
    const out = extractPgFields(err);
    expect(out).toEqual({
      code: "23503",
      constraint: "page_snapshots_page_id_fkey",
      table: "page_snapshots",
      detail: "Key (page_id)=(abc) is not present in table 'pages'.",
    });
  });

  it("walks .cause for drizzle-wrapped errors", () => {
    const drizzleErr = {
      message: "Failed query: INSERT …",
      cause: {
        code: "23505",
        constraint: "pages_slug_locale_unique",
        message: "duplicate key value violates unique constraint",
      },
    };
    const out = extractPgFields(drizzleErr);
    expect(out?.code).toBe("23505");
    expect(out?.constraint).toBe("pages_slug_locale_unique");
  });

  it("uses .errno when .code is absent (Bun.SQL fallback)", () => {
    const err = {
      errno: "42P01",
      message: 'relation "ghost_table" does not exist',
    };
    expect(extractPgFields(err)?.code).toBe("42P01");
  });

  it("returns null on cause-chains deeper than 5", () => {
    let chain: object = {}; // empty leaf
    for (let i = 0; i < 10; i++) chain = { cause: chain };
    expect(extractPgFields(chain)).toBeNull();
  });

  it("stops at the first level with PG signal (doesn't merge across causes)", () => {
    const err = {
      code: "23503",
      cause: { code: "OTHER_ERROR", constraint: "shouldnt-pick-this" },
    };
    expect(extractPgFields(err)?.code).toBe("23503");
    expect(extractPgFields(err)?.constraint).toBeUndefined();
  });
});
