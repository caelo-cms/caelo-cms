// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1277 — the one path format, the one formatter, and the
 * classification of thrown errors. Text and `errors[]` must agree, and
 * no Postgres internals may reach the text.
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { thrownToQueryError } from "../adapter.js";
import {
  errorDetailsOf,
  failureKindOf,
  formatErrorDetails,
  formatErrorPath,
  handlerErrorFromDetails,
  internalError,
  MAX_RENDERED_ERRORS,
  parseErrorPath,
  prefixErrorDetails,
  zodIssuesToErrorDetails,
} from "../error-details.js";
import { describePgFailure } from "../pg-failure.js";

describe("formatErrorPath / parseErrorPath", () => {
  it("renders segment paths as accessors", () => {
    expect(formatErrorPath(["modules", 3, "content", "values", "hero_title"])).toBe(
      "modules[3].content.values.hero_title",
    );
    expect(formatErrorPath([])).toBe("(root)");
    expect(formatErrorPath(["values", "hero title"])).toBe('values["hero title"]');
  });

  it("round-trips through parseErrorPath", () => {
    for (const path of [
      ["items", 2, "values", "label"],
      ["nodes", "entry", "fields", 0],
      ["values", "hero title", 1],
      [],
    ]) {
      expect(parseErrorPath(formatErrorPath(path))).toEqual(path);
    }
  });
});

describe("formatErrorDetails", () => {
  it("renders one problem inline with allowed + next", () => {
    expect(
      formatErrorDetails([
        {
          path: ["modules", 1, "blockName"],
          message: "no such block.",
          allowed: ["content"],
          next: "Pick one.",
        },
      ]),
    ).toBe("`modules[1].blockName`: no such block (allowed: content). Pick one.");
  });

  it("renders several problems one per line and caps at MAX_RENDERED_ERRORS", () => {
    const many = Array.from({ length: MAX_RENDERED_ERRORS + 3 }, (_, i) => ({
      path: ["items", i],
      message: "bad",
    }));
    const text = formatErrorDetails(many);
    expect(text.startsWith(`${many.length} problems:`)).toBe(true);
    expect(text).toContain("`items[19]`: bad.");
    expect(text).not.toContain("`items[20]`");
    expect(text).toContain("+3 more");
  });
});

describe("structured errors", () => {
  it("zod issues keep their absolute path and enum values", () => {
    const schema = z.object({ page: z.object({ status: z.enum(["draft", "published"]) }) });
    const parsed = schema.safeParse({ page: { status: "live" } });
    if (parsed.success) throw new Error("expected a failure");
    const details = zodIssuesToErrorDetails(parsed.error.issues);
    expect(details[0]?.path).toEqual(["page", "status"]);
    expect(details[0]?.allowed).toEqual(['"draft"', '"published"']);
    expect(prefixErrorDetails(["items", 0], details)[0]?.path).toEqual([
      "items",
      0,
      "page",
      "status",
    ]);
  });

  it("handlerErrorFromDetails renders exactly its errors[]", () => {
    const details = [
      { path: ["a", 0], message: "x" },
      { path: ["b"], message: "y" },
    ];
    const e = handlerErrorFromDetails("op.x", details, { lead: "Nothing was written." });
    expect(e.errors).toEqual(details);
    expect(e.message).toBe(`Nothing was written. ${formatErrorDetails(details)}`);
    expect(errorDetailsOf(e)).toEqual(details);
  });

  it("failureKindOf passes kinds through and marks defects internal", () => {
    expect(failureKindOf({ kind: "ValidationFailed", issues: [] })).toBe("ValidationFailed");
    expect(failureKindOf({ kind: "Locked" })).toBe("Locked");
    expect(failureKindOf({ kind: "HandlerError", message: "x" })).toBe("HandlerError");
    expect(failureKindOf(internalError("op.x", "insert returned no row"))).toBe("internal");
    expect(failureKindOf(new Error("boom"))).toBe("internal");
  });
});

/** A Bun.SQL server error as the driver throws it (code = Bun's class, errno = SQLSTATE). */
function bunPgError(fields: Record<string, string>): Error {
  return Object.assign(new Error(fields.message ?? "server error"), {
    code: "ERR_POSTGRES_SERVER_ERROR",
    ...fields,
  });
}

describe("thrownToQueryError — no Postgres internals in the text", () => {
  it("maps a unique violation to the caller's value", () => {
    const e = thrownToQueryError(
      "modules.create",
      bunPgError({
        errno: "23505",
        message: 'duplicate key value violates unique constraint "modules_slug_branch_uidx"',
        detail: "Key (slug)=(hero-3) already exists.",
        constraint: "modules_slug_branch_uidx",
        table: "modules",
      }),
      "write",
    );
    if (e.kind !== "HandlerError") throw new Error("expected a HandlerError");
    expect(e.message).toBe('`slug` "hero-3" already exists — choose a different value');
    expect(e.message).not.toContain("modules_slug_branch_uidx");
    expect(e.internal).toBeUndefined();
    // The raw fields stay for the audit surface.
    expect(e.pgDetail?.constraint).toBe("modules_slug_branch_uidx");
  });

  it("marks an unclassified driver error internal and hides its SQL", () => {
    const e = thrownToQueryError(
      "pages.build_page",
      Object.assign(new Error("Failed query: INSERT INTO x"), {
        cause: bunPgError({ errno: "XX000", message: "internal" }),
      }),
      "write",
    );
    expect(failureKindOf(e)).toBe("internal");
    if (e.kind !== "HandlerError") throw new Error("expected a HandlerError");
    expect(e.message).not.toContain("Failed query");
    expect(e.message).not.toContain("SQLSTATE");
  });

  it("turns an RLS denial into an actionable sentence", () => {
    const e = thrownToQueryError(
      "pages.update",
      bunPgError({
        errno: "42501",
        message: 'new row violates row-level security policy for table "pages"',
      }),
      "write",
    );
    expect(e.kind).toBe("RLSDenied");
    if (e.kind !== "RLSDenied") return;
    expect(e.detail).not.toContain("policy for table");
    expect(e.detail).toContain("list tool");
  });

  it("describes every caller-fixable SQLSTATE without constraint or table", () => {
    for (const code of ["23505", "23503", "23502", "23514", "22P02", "22001", "22003"]) {
      const d = describePgFailure({
        code,
        constraint: "secret_c",
        table: "secret_t",
        column: "slug",
      });
      expect(d.internal).toBe(false);
      expect(d.message).not.toContain("secret_c");
      expect(d.message).not.toContain("secret_t");
      expect(d.message).not.toContain("SQLSTATE");
    }
    expect(describePgFailure({ code: "40P01" }).internal).toBe(true);
  });
});

describe("linear-time text helpers (CodeQL js/polynomial-redos)", () => {
  it("trimTrailingPunctuation strips trailing dots and whitespace only", async () => {
    const { trimTrailingPunctuation } = await import("../error-details.js");
    expect(trimTrailingPunctuation("slug exists. \n\t ")).toBe("slug exists");
    expect(trimTrailingPunctuation("a.b")).toBe("a.b");
    expect(trimTrailingPunctuation("...")).toBe("");
    const long = `x${"\t".repeat(200_000)}y`;
    const t0 = performance.now();
    expect(trimTrailingPunctuation(long)).toBe(long);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("describePgFailure reads Key (...)=(...) without backtracking", async () => {
    const { describePgFailure } = await import("../pg-failure.js");
    const ok = describePgFailure({
      code: "23505",
      detail: "Key (slug)=(hero-3) already exists.",
    });
    expect(ok.message).toContain('"hero-3"');
    const evil = `Key (${"Key ((".repeat(50_000)}`;
    const t0 = performance.now();
    describePgFailure({ code: "23505", detail: evil });
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
