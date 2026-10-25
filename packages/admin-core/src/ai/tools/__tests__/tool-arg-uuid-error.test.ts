// SPDX-License-Identifier: MPL-2.0

/**
 * #1089 — get_quality_audit refused an `auditRunId` with a bare
 * "Invalid UUID", which does not say the id itself is malformed, so the
 * model re-sent a reconstructed id. The refusal now names what is off and
 * how to get the id right. Argument validation runs before the handler, so
 * no database is involved.
 */

import { describe, expect, it } from "bun:test";
import type { ExecutionContext } from "@caelo-cms/shared";
import { type ToolContext, ToolRegistry } from "../dispatch.js";
import { getQualityAuditTool } from "../quality-audit-tools.js";

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000000a1",
  actorKind: "ai",
  requestId: "uuid-arg-error",
};

describe("tool argument UUID errors (#1089)", () => {
  it("names the malformed group of a bad id and says to copy it exactly", async () => {
    const tools = new ToolRegistry();
    tools.register(getQualityAuditTool);
    const r = await tools.dispatch(
      "get_quality_audit",
      { auditRunId: "b2208906-1c2d-4e5f-a6b-1234567890ab" },
      AI,
      {} as ToolContext,
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain(
      '`auditRunId`: "b2208906-1c2d-4e5f-a6b-1234567890ab" is not a UUID: group 4 has 3 character(s) (expected 4',
    );
    expect(r.content).toMatch(/Copy the id character for character/);
  });

  it("names a shortened id", async () => {
    const tools = new ToolRegistry();
    tools.register(getQualityAuditTool);
    const r = await tools.dispatch(
      "get_quality_audit",
      { auditRunId: "b2208906…" },
      AI,
      {} as ToolContext,
    );
    expect(r.content).toMatch(/`auditRunId`: "b2208906…" is not a UUID: it is shortened/);
  });
});
