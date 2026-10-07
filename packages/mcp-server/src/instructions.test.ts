// SPDX-License-Identifier: MPL-2.0
/**
 * #552: both MCP servers send `instructions` in their initialize result,
 * so a connecting agent learns the session protocol without the operator
 * pasting it. Driven through the real SDK client over an in-memory
 * transport, i.e. exactly what Claude Code receives on connect.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startAdminMcpServer } from "./admin-server.js";
import { startMcpServer } from "./server.js";

let catalogueStub: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  // The admin server fetches its tool catalogue at startup.
  catalogueStub = Bun.serve({
    port: 0,
    fetch: () => Response.json({ tools: [] }),
  });
});

afterAll(() => {
  catalogueStub.stop(true);
});

async function connect(
  start: (transport: InMemoryTransport) => Promise<void>,
): Promise<{ client: Client; instructions: string | undefined }> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await start(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return { client, instructions: client.getInstructions() };
}

describe("#552 MCP instructions", () => {
  it("admin server tells the agent to open a session, load context and always-applies skills", async () => {
    const { client, instructions } = await connect((transport) =>
      startAdminMcpServer({
        adminUrl: `http://127.0.0.1:${catalogueStub.port}`,
        token: "mcp_test",
        transport,
      }),
    );
    expect(instructions).toContain("caelo_open_session");
    expect(instructions).toContain("caelo_get_context");
    expect(instructions).toContain("ALWAYS APPLIES");
    expect(instructions).toContain("load_skill");
    // The order is the protocol: session before context.
    expect(instructions!.indexOf("caelo_open_session")).toBeLessThan(
      instructions!.indexOf("caelo_get_context"),
    );
    await client.close();
  });

  it("chat server explains caelo_chat sessions and the preview branch", async () => {
    const { client, instructions } = await connect((transport) =>
      startMcpServer({ adminUrl: "http://127.0.0.1:1", token: "mcp_test", transport }),
    );
    expect(instructions).toContain("caelo_chat");
    expect(instructions).toContain("chatSessionId");
    expect(instructions).toContain("preview branch");
    await client.close();
  });
});
