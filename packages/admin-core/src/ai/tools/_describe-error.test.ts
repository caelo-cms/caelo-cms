// SPDX-License-Identifier: MPL-2.0

/**
 * v0.5.17 — wording-lock + behavior tests for `describeError`.
 *
 * Pre-v0.5.17 the AI tool error surface was just "Failed query: <sql>"
 * with no diagnostic value because the adapter dropped Postgres
 * structured fields when wrapping the throw. v0.5.17 routes them
 * through `HandlerError.pgDetail`. These tests lock the new path so a
 * future refactor doesn't silently regress the operator's diagnostic
 * surface.
 */

import { describe, expect, it } from "bun:test";
import { describeError } from "./_describe-error.js";

describe("describeError", () => {
  it("renders pgDetail as the primary message when present", () => {
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
    expect(out).toContain("SQLSTATE 23503");
    expect(out).toContain("constraint=page_snapshots_page_id_fkey");
    expect(out).toContain("table=page_snapshots");
    expect(out).toContain("Key (page_id)=(abc)");
    // Crucially: the truncated SQL text MUST NOT survive.
    expect(out).not.toContain("Failed query");
    expect(out).not.toContain("INSERT INTO");
  });

  it("falls back to the legacy walker when pgDetail is missing but message is a Failed query string", () => {
    // Synthetic shape: HandlerError without pgDetail (e.g. a handler
    // built its own without going through the adapter), but with a
    // .cause carrying the real reason.
    const err = {
      kind: "HandlerError",
      operation: "synthetic",
      message: "Failed query: SELECT … FROM foo\nparams: bar",
      cause: { code: "42P01", message: 'relation "foo" does not exist' },
    };
    const out = describeError(err);
    expect(out).toContain("SQLSTATE 42P01");
  });

  it("returns the message as-is when there's no SQL signal anywhere", () => {
    const err = {
      kind: "HandlerError",
      operation: "x",
      message: "manual handler-thrown error: bad input",
    };
    expect(describeError(err)).toBe("manual handler-thrown error: bad input");
  });

  it("formats validation errors with the issue path", () => {
    const err = {
      kind: "ValidationFailed",
      issues: [
        { path: ["body", "email"], message: "Invalid email" },
        { path: ["body", "name"], message: "Required" },
      ],
    };
    expect(describeError(err)).toContain("body.email: Invalid email");
    expect(describeError(err)).toContain("body.name: Required");
  });

  it("returns 'unknown' for non-error inputs", () => {
    expect(describeError(null)).toBe("unknown");
    expect(describeError("just a string")).toBe("unknown");
  });

  it("truncates very long pgDetail output to 240 chars", () => {
    const err = {
      kind: "HandlerError",
      operation: "x",
      message: "Failed query: …",
      pgDetail: { detail: "x".repeat(500) },
    };
    expect(describeError(err).length).toBeLessThanOrEqual(240);
  });
});
