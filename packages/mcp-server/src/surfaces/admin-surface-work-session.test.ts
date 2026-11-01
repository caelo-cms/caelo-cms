// SPDX-License-Identifier: MPL-2.0

/**
 * #1306 — a remote connection that sends no `Mcp-Session-Id` cannot carry
 * its work session from one call to the next. caelo_open_session says so
 * and names the id to pass; a call without it shows the backend's refusal
 * (which names the opened session) instead of the generic "open one first"
 * that made agents reopen in a loop.
 */

import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type AdminSurfaceBackend,
  createAdminMcpServer,
  NoWorkSessionError,
  type OpenSessionResponse,
} from "./admin-surface.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const TOOLS = [{ name: "list_pages", description: "d", inputSchema: { type: "object" } }];
const REFUSAL = `no_work_session: you already opened work session ${SESSION}, pass workSessionId`;

async function connect(open: OpenSessionResponse): Promise<Client> {
  const backend: AdminSurfaceBackend = {
    listCatalogue: async () => TOOLS,
    findTool: async (name) => TOOLS.find((t) => t.name === name),
    openSession: async () => open,
    executeTool: async ({ chatSessionId }) => {
      if (!chatSessionId) throw new NoWorkSessionError(REFUSAL);
      return { ok: true, content: "ran", requestId: "r", toolCallId: "c", cached: false };
    },
    getContext: async () => ({ systemContext: "", statusLine: null, skills: [] }),
    fetchApprovalOutcome: async () => {
      throw new Error("unused");
    },
    uploadImages: async () => ({ content: [] }),
    catalogueMayHaveChanged: async () => false,
  };
  const server = createAdminMcpServer(backend, {
    serverVersion: "0.0.0",
    approvalWaitMs: () => 1000,
    listChanged: true,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

function text(r: unknown): string {
  return ((r as { content: Array<{ text?: string }> }).content ?? [])
    .map((c) => c.text ?? "")
    .join("\n");
}

const OPENED = { chatSessionId: SESSION, chatBranchId: "b", title: "t", resumed: false };

describe("admin surface: work session on a connection without Mcp-Session-Id (#1306)", () => {
  it("the open result says the session is not carried and names the id to pass", async () => {
    const client = await connect({ ...OPENED, carriedByConnection: false });
    const r = await client.callTool({ name: "caelo_open_session", arguments: {} });
    const t = text(r);
    expect(t).toContain("sends no Mcp-Session-Id");
    expect(t).toContain(`workSessionId: "${SESSION}" on EVERY call`);
    expect(t).toContain("Do not call caelo_open_session again");
    await client.close();
  });

  it("a carried session keeps the shared-connection hint only", async () => {
    const client = await connect(OPENED);
    const t = text(await client.callTool({ name: "caelo_open_session", arguments: {} }));
    expect(t).not.toContain("Mcp-Session-Id");
    expect(t).toContain("If other agents share this connection");
    await client.close();
  });

  it("a call without a session shows the backend's refusal naming the session", async () => {
    const client = await connect({ ...OPENED, carriedByConnection: false });
    const r = await client.callTool({ name: "list_pages", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(REFUSAL);
    const ok = await client.callTool({ name: "list_pages", arguments: { workSessionId: SESSION } });
    expect(ok.isError).toBeFalsy();
    await client.close();
  });

  it("the default refusal still says to open a session", () => {
    expect(new NoWorkSessionError().message).toContain("call caelo_open_session first");
  });
});
