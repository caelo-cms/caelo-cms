// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin lifecycle tools: the revoke is approval-gated on the plugins
 * propose/execute pair, reject / revalidate / list_plugin_grants are direct,
 * all four reach the Power-MCP catalogue, and the revoke schema only accepts
 * real capability names.
 */

import { describe, expect, it } from "bun:test";
import { powerToolCatalogue } from "../../../ops/security/mcp_power.js";
import { createDefaultToolRegistry } from "../index.js";
import { proposeRevokePluginCapabilityTool } from "../plugin-lifecycle-tools.js";

const tools = createDefaultToolRegistry();
const byName = (name: string) => tools.catalogue().find((t) => t.name === name);

describe("plugin lifecycle tools", () => {
  it("propose_revoke_plugin_capability is gated on plugins.propose_revoke_capability", () => {
    const t = byName("propose_revoke_plugin_capability");
    expect(t?.approvalMode).toBe("user-approval");
    expect(t?.gated).toEqual({
      proposeOp: "plugins.propose_revoke_capability",
      executeOp: "plugins.execute_proposal",
      pendingQueuePath: "/security/pending",
    });
  });

  it("reject_plugin, revalidate_plugin and list_plugin_grants are direct", () => {
    for (const name of ["reject_plugin", "revalidate_plugin", "list_plugin_grants"]) {
      const t = byName(name);
      expect(t).toBeDefined();
      expect(t?.gated).toBeUndefined();
      expect(t?.approvalMode).toBeUndefined();
    }
  });

  it("all four are on the Power-MCP catalogue; the revoke flagged gated", () => {
    const power = powerToolCatalogue(tools);
    expect(power.find((t) => t.name === "propose_revoke_plugin_capability")?.gated).toBe(true);
    for (const name of ["reject_plugin", "revalidate_plugin", "list_plugin_grants"]) {
      expect(power.some((t) => t.name === name)).toBe(true);
    }
  });

  it("the revoke schema accepts known capabilities only and defaults to the running version", () => {
    const ok = proposeRevokePluginCapabilityTool.schema.safeParse({
      slug: "notes",
      capability: "private_files",
    });
    expect(ok.success).toBe(true);
    expect(ok.success && (ok.data as { target: string }).target).toBe("running");
    expect(
      proposeRevokePluginCapabilityTool.schema.safeParse({ slug: "notes", capability: "root" })
        .success,
    ).toBe(false);
    expect(
      proposeRevokePluginCapabilityTool.schema.safeParse({
        slug: "notes",
        capability: "private_files",
        installationId: "x",
      }).success,
    ).toBe(false);
  });
});
