// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { mapRowToOutput, opError, toIso } from "../_helpers.js";

describe("ops helpers", () => {
  it("builds canonical HandlerError objects", () => {
    expect(opError("deploy.propose_promote", "bad input")).toEqual({
      kind: "HandlerError",
      operation: "deploy.propose_promote",
      message: "bad input",
    });
  });

  it("normalizes timestamps via toIso", () => {
    expect(toIso(null)).toBeNull();
    expect(toIso(undefined)).toBeNull();
    expect(toIso("2026-01-01T00:00:00.000Z")).toBe("2026-01-01T00:00:00.000Z");
    expect(toIso(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01T00:00:00.000Z");
  });

  it("maps and validates rows against the output schema", () => {
    const outSchema = z.object({ id: z.string(), createdAt: z.string() });
    const mapped = mapRowToOutput(
      { id: "x", created_at: "2026-01-01T00:00:00.000Z" },
      outSchema,
      (r) => ({
        id: r.id,
        createdAt: String(r.created_at),
      }),
    );
    expect(mapped).toEqual({ id: "x", createdAt: "2026-01-01T00:00:00.000Z" });
  });
});
