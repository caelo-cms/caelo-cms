// SPDX-License-Identifier: MPL-2.0

/**
 * Plan B (SDK approval gate, CLAUDE.md §11.A) — every `propose_*` tool is now
 * SDK-executed + human-approval-gated: `makeProposeTool` marks it
 * `approvalMode: "user-approval"` and records the `gated` op pair
 * (`<domain>.propose_*` + `<domain>.execute_proposal`) the chat-runner chains
 * after the Owner's in-chat Approve. This replaces the old
 * "emit a Queued-proposal string → ProposeCard content-regex → click at
 * /security/pending" choreography.
 *
 * This test locks the gated contract: the markers are present, the executeOp is
 * derived correctly, and each description tells the model NOT to claim the
 * change is live before approval.
 */

import { describe, expect, it } from "bun:test";
import { createDefaultToolRegistry } from "../index.js";

/**
 * Bespoke propose tools with their OWN multi-step flows, NOT the uniform
 * makeProposeTool propose→execute_proposal shape, so they are not part of the
 * SDK-gated fan-out: `propose_skill` (propose → accept → Owner activate) and
 * `propose_site_import` (injects a computed crawl-scope estimate + arms a cost
 * ceiling). They keep their own dispatch handlers + approval surfaces.
 */
const BESPOKE_PROPOSE_TOOLS = new Set(["propose_skill", "propose_site_import"]);

describe("propose_* tools are SDK approval-gated (Plan B)", () => {
  const registry = createDefaultToolRegistry();
  const proposeTools = registry
    .catalogue()
    .filter((t) => t.name.startsWith("propose_") && !BESPOKE_PROPOSE_TOOLS.has(t.name));

  it("finds the propose surface", () => {
    // Guards against the filter silently matching nothing if names change.
    expect(proposeTools.length).toBeGreaterThan(20);
  });

  for (const name of [
    "propose_add_locale",
    "propose_remove_locale",
    "propose_set_default_locale",
    "propose_update_locale_strategy",
    "propose_deploy_promote",
    "propose_deploy_rollback",
    "propose_update_layout",
    "propose_create_user",
  ]) {
    it(`${name} is registered`, () => {
      expect(proposeTools.map((t) => t.name)).toContain(name);
    });
  }

  describe("every propose_* tool carries the gated markers", () => {
    for (const tool of proposeTools) {
      it(`${tool.name}: approvalMode + gated{proposeOp, executeOp} derived correctly`, () => {
        expect(tool.approvalMode).toBe("user-approval");
        expect(tool.gated).toBeDefined();
        const proposeOp = tool.gated?.proposeOp ?? "";
        const executeOp = tool.gated?.executeOp ?? "";
        // proposeOp is `<domain>.propose_*`; executeOp is its paired
        // `<domain>.execute_proposal` in the SAME domain.
        expect(proposeOp).toMatch(/^[a-z_]+\.propose_/);
        const domain = proposeOp.split(".")[0];
        expect(executeOp).toBe(`${domain}.execute_proposal`);
      });
    }
  });

  describe("every propose_* description forbids claiming the change is live", () => {
    for (const tool of proposeTools) {
      it(`${tool.name}: says approval-gated + do not claim success`, () => {
        const d = tool.description.toLowerCase();
        expect(d).toContain("approval-gated");
        expect(
          /do not claim|does not apply|not active yet|pauses/i.test(tool.description),
          `${tool.name} description must tell the model NOT to claim the change is live`,
        ).toBe(true);
      });
    }
  });
});
