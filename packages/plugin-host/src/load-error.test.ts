// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { describeLoadError } from "./load-error.js";

describe("describeLoadError", () => {
  it("keeps the SQLSTATE and detail of the Postgres cause under a drizzle error", () => {
    const pg = Object.assign(
      new Error('duplicate key value violates unique constraint "pg_namespace_nspname_index"'),
      {
        errno: "23505",
        code: "ERR_POSTGRES_SERVER_ERROR",
        detail: "Key (nspname)=(plugin_x) already exists.",
      },
    );
    const drizzle = new Error(
      `Failed query: CREATE SCHEMA IF NOT EXISTS "plugin_x";\n\nCREATE TABLE ${"x".repeat(500)}`,
      { cause: pg },
    );
    expect(describeLoadError(drizzle)).toBe(
      'Failed query: CREATE SCHEMA IF NOT EXISTS "plugin_x"; ← [23505] duplicate key value violates unique constraint "pg_namespace_nspname_index" (Key (nspname)=(plugin_x) already exists.)',
    );
  });

  it("keeps every other message whole, so an activation reason is never cut", () => {
    const reason = `${"x".repeat(300)} — this slug belongs in another plugin's namespace`;
    expect(describeLoadError(new Error(reason))).toBe(reason);
    expect(describeLoadError(new Error("line one\nline two"))).toBe("line one\nline two");
    expect(describeLoadError("plain string")).toBe("plain string");
  });

  it("caps a runaway message and a long failing statement", () => {
    expect(describeLoadError(new Error("a".repeat(2100)))).toBe(`${"a".repeat(2000)}…`);
    expect(describeLoadError(new Error(`Failed query: ${"b".repeat(300)}`))).toBe(
      `Failed query: ${"b".repeat(146)}…`,
    );
  });

  it("ignores an errno that is not a SQLSTATE", () => {
    expect(describeLoadError(Object.assign(new Error("boom"), { errno: -2 }))).toBe("boom");
  });
});
