// SPDX-License-Identifier: MPL-2.0

/**
 * MCP `instructions` + `serverInfo.version` in the initialize result.
 * Clients (Claude Code et al.) inject `instructions` into the model's
 * context on connect; without them a freshly connected agent didn't know
 * it must open a session, load the site context and load skills before
 * working. Exercised over a real MCP client <-> server handshake on an
 * in-memory transport pair — no network, the remote catalogue is a
 * fixture (the admin server only fetches it in startAdminMcpServer).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ADMIN_MCP_INSTRUCTIONS, createAdminMcpServer } from "./admin-server.js";
import { CHAT_MCP_INSTRUCTIONS, createMcpServer } from "./server.js";

const opts = { adminUrl: "https://admin.example.com", token: "tok_123" };
const packageVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

async function connect(server: Server): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("admin Power-MCP initialize result", () => {
  it("carries instructions naming the session -> context -> skills order", async () => {
    const client = await connect(
      createAdminMcpServer(opts, [
        { name: "load_skill", description: "Load skills.", inputSchema: { type: "object" } },
      ]),
    );
    const instructions = client.getInstructions();
    expect(instructions).toBe(ADMIN_MCP_INSTRUCTIONS);
    const open = ADMIN_MCP_INSTRUCTIONS.indexOf("caelo_open_session");
    const context = ADMIN_MCP_INSTRUCTIONS.indexOf("caelo_get_context");
    const skill = ADMIN_MCP_INSTRUCTIONS.indexOf("load_skill");
    expect(open).toBeGreaterThanOrEqual(0);
    expect(context).toBeGreaterThan(open);
    expect(skill).toBeGreaterThan(context);
    expect(ADMIN_MCP_INSTRUCTIONS).toContain("ALWAYS APPLIES");
    await client.close();
  });

  it("names only tools the server actually lists", async () => {
    const client = await connect(
      createAdminMcpServer(opts, [
        { name: "load_skill", description: "Load skills.", inputSchema: { type: "object" } },
      ]),
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const tool of ["caelo_open_session", "caelo_get_context", "load_skill"]) {
      expect(names).toContain(tool);
    }
    await client.close();
  });

  it("reports the package version instead of a hard-coded 0.1.0", async () => {
    const client = await connect(createAdminMcpServer(opts, []));
    expect(client.getServerVersion()).toEqual({
      name: "caelo-admin-mcp",
      version: packageVersion,
    });
    await client.close();
  });
});

describe("chat MCP initialize result", () => {
  it("carries short caelo_chat instructions and the package version", async () => {
    const client = await connect(createMcpServer(opts));
    expect(client.getInstructions()).toBe(CHAT_MCP_INSTRUCTIONS);
    expect(CHAT_MCP_INSTRUCTIONS).toContain("caelo_chat");
    expect(CHAT_MCP_INSTRUCTIONS).toContain("chatSessionId");
    expect(client.getServerVersion()?.version).toBe(packageVersion);
    await client.close();
  });
});
