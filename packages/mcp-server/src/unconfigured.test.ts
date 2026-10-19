// SPDX-License-Identifier: MPL-2.0
/**
 * #841: without CAELO_ADMIN_URL / CAELO_MCP_TOKEN both bins still answer
 * initialize + tools/list (MCP directories inspect servers that way) and
 * fail every tool call with the variables to set. The in-process cases
 * drive the real SDK client; the spawn case runs the actual bin with an
 * empty environment, which is what Glama's build check does.
 */
import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ADMIN_LOCAL_TOOLS } from "./admin-server.js";
import { CHAT_TOOLS } from "./server.js";
import {
  describeMissingCredentials,
  loadPowerCatalogue,
  missingCredentials,
  startUnconfiguredServer,
} from "./unconfigured.js";

async function connect(mode: "chat" | "admin"): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await startUnconfiguredServer({
    mode,
    missing: ["CAELO_ADMIN_URL", "CAELO_MCP_TOKEN"],
    transport: serverSide,
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

describe("#841 missingCredentials", () => {
  it("names each unset or empty variable", () => {
    expect(missingCredentials({})).toEqual(["CAELO_ADMIN_URL", "CAELO_MCP_TOKEN"]);
    expect(
      missingCredentials({ CAELO_ADMIN_URL: "https://a.example", CAELO_MCP_TOKEN: "" }),
    ).toEqual(["CAELO_MCP_TOKEN"]);
    expect(
      missingCredentials({ CAELO_ADMIN_URL: "https://a.example", CAELO_MCP_TOKEN: "mcp_x" }),
    ).toEqual([]);
  });
});

describe("#841 unconfigured server", () => {
  it("chat mode lists the same tools as a configured chat server", async () => {
    const client = await connect("chat");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(CHAT_TOOLS.map((t) => t.name));
    expect(client.getServerVersion()?.name).toBe("caelo-mcp-server");
    expect(client.getInstructions()).toContain("caelo_chat");
    await client.close();
  });

  it("admin mode lists its local tools plus the shipped Power-MCP catalogue", async () => {
    const client = await connect("admin");
    const { tools } = await client.listTools();
    const catalogue = loadPowerCatalogue();
    expect(catalogue.length).toBeGreaterThan(100);
    expect(tools.map((t) => t.name)).toEqual([
      ...ADMIN_LOCAL_TOOLS.map((t) => t.name),
      ...catalogue.map((t) => t.name),
    ]);
    expect(tools.map((t) => t.name)).toContain("build_page");
    expect(client.getServerVersion()?.name).toBe("caelo-admin-mcp");
    await client.close();
  });

  it("fails every tool call with the variables to set", async () => {
    const client = await connect("chat");
    const result = await client.callTool({ name: "caelo_chat", arguments: { message: "hi" } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toBe(describeMissingCredentials("chat", ["CAELO_ADMIN_URL", "CAELO_MCP_TOKEN"]));
    expect(text).toContain("CAELO_ADMIN_URL and CAELO_MCP_TOKEN are not set");
    expect(text).toContain("/settings/mcp");
    await client.close();
  });

  it("admin mode asks for an admin-scoped token", () => {
    expect(describeMissingCredentials("admin", ["CAELO_MCP_TOKEN"])).toContain(
      "CAELO_MCP_TOKEN is not set",
    );
    expect(describeMissingCredentials("admin", ["CAELO_MCP_TOKEN"])).toContain("ADMIN-scoped");
  });

  for (const [label, bin, args] of [
    ["caelo-mcp-server", "index.ts", []],
    ["caelo-mcp-server admin", "index.ts", ["admin"]],
    ["caelo-admin-mcp", "admin.ts", []],
  ] as const) {
    it(`the ${label} bin starts with an empty environment and lists tools`, async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [resolve(import.meta.dir, bin), ...args],
        // PATH only: no CAELO_* variables reach the child.
        env: { PATH: process.env.PATH ?? "" },
        stderr: "pipe",
      });
      const client = new Client({ name: "test", version: "0.0.0" });
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      await client.close();
    });
  }
});
