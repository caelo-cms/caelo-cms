// SPDX-License-Identifier: MPL-2.0

/** The shared failure mapping of the /api/mcp/* routes (incl. /api/mcp/version, #764). */

import { describe, expect, it } from "bun:test";
import { SYSTEM_ACTOR_ID } from "@caelo-cms/query-api";
import { z } from "zod";
import { mcpOpFailure, mcpSystemCtx } from "./mcp-http.js";

describe("mcpOpFailure", () => {
  it("maps a dead token to 401 with the op's message", () => {
    expect(
      mcpOpFailure(
        {
          kind: "HandlerError",
          operation: "mcp.get_version",
          message: "auth_error: token revoked",
        },
        "mcp.get_version",
      ),
    ).toEqual({ status: 401, message: "auth_error: token revoked" });
  });

  it("maps an op-input validation failure to 400, not 500", () => {
    // What mcp.get_version's validator returns for a too-short bearer.
    const parsed = z
      .object({ plaintextToken: z.string().min(8) })
      .safeParse({ plaintextToken: "x" });
    if (parsed.success) throw new Error("expected the fixture to fail validation");
    const failure = mcpOpFailure(
      { kind: "ValidationFailed", issues: parsed.error.issues },
      "mcp.get_version",
    );
    expect(failure.status).toBe(400);
    expect(failure.message).toStartWith("invalid request: ");
    expect(failure.message).toContain("plaintextToken");
  });

  it("maps anything else to 500", () => {
    expect(
      mcpOpFailure(
        {
          kind: "HandlerError",
          operation: "mcp.get_version",
          message: "MCP bridge not configured",
        },
        "mcp.get_version",
      ),
    ).toEqual({ status: 500, message: "MCP bridge not configured" });
    expect(
      mcpOpFailure({ kind: "UnknownOperation", name: "mcp.get_version" }, "mcp.get_version"),
    ).toEqual({ status: 500, message: "UnknownOperation" });
  });
});

it("mcpSystemCtx dispatches as the system actor", () => {
  expect(mcpSystemCtx("mcp-http-version")).toEqual({
    actorId: SYSTEM_ACTOR_ID,
    actorKind: "system",
    requestId: "mcp-http-version",
  });
});
