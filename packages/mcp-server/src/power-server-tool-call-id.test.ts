// SPDX-License-Identifier: MPL-2.0

/**
 * #1704 — the idempotency key the stdio shim sends with every catalogue call
 * (`toolCallId` on `/api/mcp/tool`) names that call: a JSON-RPC id the
 * client sends again for another call gets another key, so the admin runs
 * it instead of answering with the earlier call's cached result; a resend
 * of the same request keeps its key. A second process — a restarted shim
 * that resumes the same work session — never makes the first one's keys.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { startPowerMcpServer } from "./power-server.js";

const TOOLS = [
  { name: "read_content", description: "d", inputSchema: { type: "object" } },
  { name: "list_pages", description: "d", inputSchema: { type: "object" } },
];

/** The `/api/mcp/tool` bodies the shim sent, in order. */
const sent: Array<{ toolName: string; toolCallId: string }> = [];
let stub: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  stub = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/api/mcp/tools") return Response.json({ tools: TOOLS });
      if (path === "/api/mcp/session") {
        return Response.json({
          chatSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          chatBranchId: "b",
          title: "t",
          resumed: true,
        });
      }
      if (path === "/api/mcp/tool") {
        const body = (await req.json()) as { toolName: string; toolCallId: string };
        sent.push({ toolName: body.toolName, toolCallId: body.toolCallId });
        return Response.json({
          ok: true,
          content: `ran ${body.toolName}`,
          requestId: "r",
          toolCallId: body.toolCallId,
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

/**
 * One shim process, driven with raw JSON-RPC so a test picks every id —
 * also one it already used, as a client that counts from 0 again does.
 */
async function startShim(): Promise<{
  call: (id: number, name: string, args: Record<string, unknown>) => Promise<string>;
}> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await startPowerMcpServer({
    adminUrl: `http://127.0.0.1:${stub.port}`,
    token: "mcp_test",
    transport: serverSide,
    catalogueMaxAgeMs: 60_000,
  });
  const waiting = new Map<number, (m: JSONRPCMessage) => void>();
  clientSide.onmessage = (m) => {
    const id = (m as { id?: unknown }).id;
    if (typeof id === "number") waiting.get(id)?.(m);
  };
  await clientSide.start();
  const request = (id: number, method: string, params: Record<string, unknown>) =>
    new Promise<JSONRPCMessage>((resolve) => {
      waiting.set(id, resolve);
      void clientSide.send({ jsonrpc: "2.0", id, method, params });
    });
  await request(0, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t1704", version: "1" },
  });
  await clientSide.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await request(1, "tools/call", { name: "caelo_open_session", arguments: {} });
  return {
    call: async (id, name, args) => {
      const before = sent.length;
      await request(id, "tools/call", { name, arguments: args });
      const body = sent[before];
      if (sent.length !== before + 1 || !body) throw new Error(`${name} reached no admin call`);
      return body.toolCallId;
    },
  };
}

describe("the stdio shim's idempotency key (#1704)", () => {
  it("a JSON-RPC id sent again for another call gets another key; a resend keeps its own", async () => {
    const shim = await startShim();
    const read = await shim.call(5, "read_content", { entityKind: "module", entityId: "m1" });
    const otherTool = await shim.call(5, "list_pages", {});
    const otherArgs = await shim.call(5, "read_content", { entityKind: "module", entityId: "m2" });
    expect(new Set([read, otherTool, otherArgs]).size).toBe(3);
    expect(await shim.call(5, "read_content", { entityId: "m1", entityKind: "module" })).toBe(read);
  });

  it("a second process never makes the first one's keys, also for the same call and id", async () => {
    const first = await startShim();
    const second = await startShim();
    expect(await first.call(7, "list_pages", {})).not.toBe(await second.call(7, "list_pages", {}));
  });
});
