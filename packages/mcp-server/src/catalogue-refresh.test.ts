// SPDX-License-Identifier: MPL-2.0

/**
 * #678 — the Power-MCP server tells the client when the admin's tool
 * catalogue changed (an upgrade, an activated plugin), so new tools show
 * up without the operator reconnecting the MCP server (`/mcp`).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  catalogueSignature,
  resolveCatalogueRefreshMs,
  startAdminMcpServer,
} from "./admin-server.js";

const OLD_TOOL = { name: "get_staging_access", description: "d", inputSchema: { type: "object" } };
const NEW_TOOL = {
  name: "propose_set_staging_host",
  description: "APPROVAL-GATED",
  inputSchema: { type: "object" },
  gated: true,
};

describe("catalogueSignature / resolveCatalogueRefreshMs", () => {
  it("ignores order and notices any change a client sees", () => {
    expect(catalogueSignature([OLD_TOOL, NEW_TOOL])).toBe(catalogueSignature([NEW_TOOL, OLD_TOOL]));
    expect(catalogueSignature([OLD_TOOL])).not.toBe(
      catalogueSignature([{ ...OLD_TOOL, description: "changed" }]),
    );
  });

  it("takes the option, then the env var, then 5 minutes", () => {
    expect(resolveCatalogueRefreshMs(0, "100")).toBe(0);
    expect(resolveCatalogueRefreshMs(undefined, "100")).toBe(100);
    expect(resolveCatalogueRefreshMs(undefined, "nonsense")).toBe(300_000);
    expect(resolveCatalogueRefreshMs(undefined, undefined)).toBe(300_000);
  });
});

describe("tool list changes reach the client", () => {
  let stub: ReturnType<typeof Bun.serve>;
  let tools: unknown[] = [OLD_TOOL];

  beforeAll(() => {
    stub = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/api/mcp/tools") return Response.json({ tools });
        if (path === "/api/mcp/session") {
          return Response.json({
            chatSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            chatBranchId: "b",
            title: "t",
            resumed: true,
          });
        }
        if (path === "/api/mcp/tool") {
          const body = (await req.json()) as { toolName: string };
          return Response.json({
            ok: true,
            content: `ran ${body.toolName}`,
            requestId: "r",
            toolCallId: "c",
            cached: false,
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
  });

  afterAll(() => {
    stub.stop(true);
  });

  async function connect(refreshMs: number): Promise<{ client: Client; changed: () => number }> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await startAdminMcpServer({
      adminUrl: `http://127.0.0.1:${stub.port}`,
      token: "mcp_test",
      transport: serverSide,
      catalogueRefreshMs: refreshMs,
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    let count = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      count++;
    });
    await client.connect(clientSide);
    return { client, changed: () => count };
  }

  it("announces listChanged and notifies after a periodic refresh finds new tools", async () => {
    tools = [OLD_TOOL];
    const { client, changed } = await connect(20);
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    expect((await client.listTools()).tools.some((t) => t.name === NEW_TOOL.name)).toBe(false);

    tools = [OLD_TOOL, NEW_TOOL];
    const deadline = Date.now() + 2000;
    while (changed() === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(changed()).toBe(1);
    expect((await client.listTools()).tools.some((t) => t.name === NEW_TOOL.name)).toBe(true);

    // An unchanged catalogue is not announced again.
    await Bun.sleep(100);
    expect(changed()).toBe(1);
    await client.close();
  });

  it("refreshes on an unknown tool name instead of refusing a tool the admin gained", async () => {
    tools = [OLD_TOOL];
    const { client, changed } = await connect(0);
    await client.callTool({ name: "caelo_open_session", arguments: {} });
    tools = [OLD_TOOL, NEW_TOOL];
    const r = await client.callTool({ name: NEW_TOOL.name, arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(JSON.stringify(r.content)).toContain(`ran ${NEW_TOOL.name}`);
    const deadline = Date.now() + 1000;
    while (changed() === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(changed()).toBe(1);

    const unknown = await client.callTool({ name: "no_such_tool", arguments: {} });
    expect(unknown.isError).toBe(true);
    await client.close();
  });
});
