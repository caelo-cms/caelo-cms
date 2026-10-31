// SPDX-License-Identifier: MPL-2.0

/**
 * Wording-lock + behaviour tests for `describeError` / `toolError`.
 *
 * v0.5.17 lifted the Postgres fields onto `HandlerError.pgDetail` so a
 * failure is diagnosable. #1277: the AI-facing text describes the failure
 * by the caller's value — never by SQLSTATE, constraint, table or SQL text
 * (those stay on `pgDetail` for the audit surface) — renders validation
 * issues in the one shared path format, and a "not found" names the tool
 * that lists the valid ids.
 */

import { describe, expect, it } from "bun:test";
import { describeError, toolError } from "./_describe-error.js";

const INTERNALS = ["SQLSTATE", "constraint=", "table=", "Failed query", "INSERT INTO", "_fkey"];

function expectNoInternals(text: string): void {
  for (const s of INTERNALS) expect(text).not.toContain(s);
}

describe("describeError", () => {
  it("describes a FK violation by the caller's value, without Postgres internals", () => {
    const err = {
      kind: "HandlerError",
      operation: "pages.create",
      message:
        "Failed query: INSERT INTO page_snapshots (site_snapshot_id, page_id, state) VALUES ($1::uuid, $2::uuid, $3::jsonb)\nparams: …",
      pgDetail: {
        code: "23503",
        constraint: "page_snapshots_page_id_fkey",
        table: "page_snapshots",
        detail: "Key (page_id)=(abc) is not present in table 'pages'.",
      },
    };
    const out = describeError(err);
    expect(out).toContain('`page_id` "abc"');
    expect(out).toContain("does not exist");
    expectNoInternals(out);
  });

  it("describes a unique violation as 'already exists'", () => {
    const out = describeError({
      kind: "HandlerError",
      operation: "modules.create",
      message: "duplicate key value violates unique constraint",
      pgDetail: { code: "23505", detail: "Key (slug)=(hero-3) already exists.", table: "modules" },
    });
    expect(out).toContain('`slug` "hero-3" already exists');
    expectNoInternals(out);
  });

  it("walks the cause chain when pgDetail is missing but message is a Failed query string", () => {
    const out = describeError({
      kind: "HandlerError",
      operation: "synthetic",
      message: "Failed query: SELECT … FROM foo\nparams: bar",
      cause: { errno: "23502", column: "title", message: "null value" },
    });
    expect(out).toContain("`title` is required");
    expectNoInternals(out);
  });

  it("never shows the SQL of a Failed query, even without any Postgres field", () => {
    const out = describeError({
      kind: "HandlerError",
      operation: "x",
      message: "Failed query: DELETE FROM secret_table",
    });
    expect(out).not.toContain("secret_table");
    expect(out).toContain("defect");
  });

  it("returns the message as-is when there's no SQL signal anywhere", () => {
    const err = {
      kind: "HandlerError",
      operation: "x",
      message: "manual handler-thrown error: bad input",
    };
    expect(describeError(err)).toBe("manual handler-thrown error: bad input");
  });

  it("formats validation errors in the shared path format, all of them up to 20", () => {
    const err = {
      kind: "ValidationFailed",
      issues: [
        { code: "custom", path: ["body", "email"], message: "Invalid email" },
        { code: "custom", path: ["items", 3, "name"], message: "Required" },
      ],
    };
    expect(describeError(err)).toContain("`body.email`: Invalid email");
    expect(describeError(err)).toContain("`items[3].name`: Required");
    const many = {
      kind: "ValidationFailed",
      issues: Array.from({ length: 25 }, (_, i) => ({
        code: "custom",
        path: ["items", i],
        message: "bad",
      })),
    };
    const text = describeError(many);
    expect(text).toContain("`items[19]`");
    expect(text).toContain("+5 more");
  });

  it("names the list tool on a bare 'not found'", () => {
    expect(
      describeError({
        kind: "HandlerError",
        operation: "themes.x",
        message: "theme abc not found",
      }),
    ).toContain("`list_themes`");
    expect(
      describeError({
        kind: "HandlerError",
        operation: "x",
        message: "content_instance abc not found",
      }),
    ).toContain("`list_content_instances`");
    // Already actionable: left alone.
    const named = "page x not found — pass a pageId from list_pages";
    expect(describeError({ kind: "HandlerError", operation: "x", message: named })).toBe(named);
  });

  it("returns 'unknown' for non-error inputs", () => {
    expect(describeError(null)).toBe("unknown");
    expect(describeError("just a string")).toBe("unknown");
  });
});

describe("toolError", () => {
  it("carries failureKind, errors[] (tool-relative) and the refusal flag", () => {
    const r = toolError(
      {
        kind: "HandlerError",
        operation: "content_instances.create_many",
        message: "x",
        refusal: true,
        errors: [{ path: ["instances", 1, "values", "count"], message: "bad" }],
      },
      "failed: x",
      { from: "instances", to: "items" },
    );
    expect(r.ok).toBe(false);
    expect(r.failureKind).toBe("HandlerError");
    expect(r.errors?.[0]?.path).toEqual(["items", 1, "values", "count"]);
    expect(r.refusal).toBe(true);
  });

  it("classifies a defect as internal and a schema refusal by its kind", () => {
    expect(
      toolError({ kind: "HandlerError", operation: "x", message: "y", internal: true }, "c")
        .failureKind,
    ).toBe("internal");
    const v = toolError(
      { kind: "ValidationFailed", issues: [{ code: "custom", path: ["a"], message: "m" }] },
      "c",
    );
    expect(v.failureKind).toBe("ValidationFailed");
    expect(v.errors?.[0]?.path).toEqual(["a"]);
  });
});
