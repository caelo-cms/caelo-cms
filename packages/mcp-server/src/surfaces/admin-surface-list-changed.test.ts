// SPDX-License-Identifier: MPL-2.0

/**
 * #1122 — the stateless remote surface lists live, so it announces a
 * changed catalogue on the stream of the call that changed it: an applied
 * proposal of the plugins domain, or a plugin reload. Anything else sends
 * nothing.
 */

import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ApprovalOutcome } from "../approval-wait.js";
import { type AdminSurfaceBackend, createAdminMcpServer } from "./admin-surface.js";

const TOOLS = ["activate_plugin", "reload_plugin", "propose_set_ai_budget"].map((name) => ({
  name,
  description: "d",
  inputSchema: { type: "object" },
}));

function outcome(domain: string): ApprovalOutcome {
  return {
    proposalId: "p1",
    domain,
    toolName: "t",
    summary: "s",
    outcome: "applied",
    detail: null,
    decidedAt: null,
  };
}

async function connect(domain: string): Promise<{ client: Client; changed: () => number }> {
  const backend: AdminSurfaceBackend = {
    listCatalogue: async () => TOOLS,
    findTool: async (name) => TOOLS.find((t) => t.name === name),
    openSession: async () => ({ chatSessionId: "s", chatBranchId: "b", title: "t", resumed: true }),
    currentSessionId: async () => "s",
    executeTool: async ({ toolName }) => ({
      ok: true,
      content: `ran ${toolName}`,
      requestId: "r",
      toolCallId: "c",
      cached: false,
      ...(toolName === "reload_plugin" ? {} : { approval: { proposalId: "p1", domain } }),
    }),
    getContext: async () => ({ systemContext: "", statusLine: null, skills: [] }),
    fetchApprovalOutcome: async () => outcome(domain),
    uploadImages: async () => ({ content: [] }),
    catalogueMayHaveChanged: async () => true,
  };
  const server = createAdminMcpServer(backend, {
    serverVersion: "0.0.0",
    approvalWaitMs: () => 1000,
    approvalPollMs: 10,
    listChanged: true,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  let count = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    count++;
  });
  await client.connect(clientSide);
  return { client, changed: () => count };
}

describe("admin surface: tools/list_changed after a catalogue change (#1122)", () => {
  it("announces an applied plugins-domain proposal", async () => {
    const { client, changed } = await connect("plugins");
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    await client.callTool({ name: "activate_plugin", arguments: { slug: "x" } });
    await Bun.sleep(20);
    expect(changed()).toBe(1);
    await client.close();
  });

  it("announces a plugin reload", async () => {
    const { client, changed } = await connect("plugins");
    await client.callTool({ name: "reload_plugin", arguments: { slug: "x" } });
    await Bun.sleep(20);
    expect(changed()).toBe(1);
    await client.close();
  });

  it("stays quiet for an applied proposal of another domain", async () => {
    const { client, changed } = await connect("owner_settings");
    await client.callTool({ name: "propose_set_ai_budget", arguments: {} });
    await Bun.sleep(20);
    expect(changed()).toBe(0);
    await client.close();
  });
});
