// SPDX-License-Identifier: MPL-2.0
/**
 * Issue #658 — a gated Power-MCP call waits for the operator's decision
 * and returns it in the same tool result; past the bounded wait it says
 * how to keep waiting. Driven through the real SDK client over an
 * in-memory transport against a stub admin.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startAdminMcpServer } from "./admin-server.js";
import {
  type ApprovalOutcome,
  describeApprovalOutcome,
  resolveApprovalWaitMs,
  waitForApproval,
} from "./approval-wait.js";

const PROPOSAL_ID = "11111111-2222-4333-8444-555555555555";

function outcome(o: ApprovalOutcome["outcome"], detail: string | null = null): ApprovalOutcome {
  return {
    proposalId: PROPOSAL_ID,
    domain: "layouts",
    toolName: "propose_delete_layout",
    summary: "delete layout 'old'",
    outcome: o,
    detail,
    decidedAt: o === "pending" ? null : "2026-10-12T10:00:00.000Z",
  };
}

describe("waitForApproval", () => {
  it("polls until the operator decided", async () => {
    const seq = [outcome("pending"), outcome("pending"), outcome("applied")];
    let calls = 0;
    const r = await waitForApproval({
      fetchOutcome: async () => seq[Math.min(calls++, seq.length - 1)]!,
      waitMs: 60_000,
      sleep: async () => {},
    });
    expect(r.outcome).toBe("applied");
    expect(calls).toBe(3);
  });

  it("returns the still-pending outcome once the bounded wait elapsed", async () => {
    let t = 0;
    const r = await waitForApproval({
      fetchOutcome: async () => outcome("pending"),
      waitMs: 10_000,
      intervalMs: 3_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(r.outcome).toBe("pending");
    expect(t).toBe(10_000);
  });

  it("returns at once with a zero wait", async () => {
    let calls = 0;
    const r = await waitForApproval({
      fetchOutcome: async () => {
        calls++;
        return outcome("pending");
      },
      waitMs: 0,
    });
    expect(r.outcome).toBe("pending");
    expect(calls).toBe(1);
  });
});

describe("describeApprovalOutcome", () => {
  it("names the next step for every outcome", () => {
    expect(describeApprovalOutcome(outcome("pending"))).toContain("caelo_await_approval");
    expect(describeApprovalOutcome(outcome("applied"))).toContain("APPROVED and applied");
    const rejected = describeApprovalOutcome(outcome("rejected", "not now"));
    expect(rejected).toContain("REJECTED");
    expect(rejected).toContain("not now");
  });
});

describe("resolveApprovalWaitMs", () => {
  const prev = process.env.CAELO_MCP_APPROVAL_WAIT_MS;
  afterEach(() => {
    if (prev === undefined) delete process.env.CAELO_MCP_APPROVAL_WAIT_MS;
    else process.env.CAELO_MCP_APPROVAL_WAIT_MS = prev;
  });
  it("defaults below the MCP client timeout and rejects garbage loudly", () => {
    delete process.env.CAELO_MCP_APPROVAL_WAIT_MS;
    expect(resolveApprovalWaitMs()).toBe(50_000);
    process.env.CAELO_MCP_APPROVAL_WAIT_MS = "abc";
    expect(() => resolveApprovalWaitMs()).toThrow(/non-negative integer/);
  });
});

describe("gated tool call over the admin MCP server", () => {
  let stub: ReturnType<typeof Bun.serve>;
  let decision: ApprovalOutcome["outcome"] = "pending";
  let approvalPolls = 0;
  const prevWait = process.env.CAELO_MCP_APPROVAL_WAIT_MS;

  beforeAll(() => {
    stub = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/api/mcp/tools") {
          return Response.json({
            tools: [
              {
                name: "propose_delete_layout",
                description: "APPROVAL-GATED",
                inputSchema: { type: "object" },
                gated: true,
              },
            ],
          });
        }
        if (path === "/api/mcp/session") {
          return Response.json({
            chatSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            chatBranchId: "b",
            title: "t",
            resumed: true,
          });
        }
        if (path === "/api/mcp/tool") {
          return Response.json({
            ok: true,
            content: `Queued proposal ${PROPOSAL_ID}: delete layout 'old'. Not applied yet.`,
            requestId: "r",
            toolCallId: "c",
            cached: false,
            image: null,
            approval: { proposalId: PROPOSAL_ID, domain: "layouts" },
          });
        }
        if (path === "/api/mcp/approval") {
          approvalPolls++;
          // The operator decides after the agent's call started waiting.
          const o = approvalPolls >= 2 ? decision : "pending";
          return Response.json(outcome(o, o === "rejected" ? "wrong layout" : null));
        }
        return new Response("not found", { status: 404 });
      },
    });
  });

  afterAll(() => {
    stub.stop(true);
    if (prevWait === undefined) delete process.env.CAELO_MCP_APPROVAL_WAIT_MS;
    else process.env.CAELO_MCP_APPROVAL_WAIT_MS = prevWait;
  });

  async function connect(): Promise<Client> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await startAdminMcpServer({
      adminUrl: `http://127.0.0.1:${stub.port}`,
      token: "mcp_test",
      transport: serverSide,
      approvalPollMs: 5,
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);
    await client.callTool({ name: "caelo_open_session", arguments: {} });
    return client;
  }

  function texts(r: Awaited<ReturnType<Client["callTool"]>>): string {
    return (r.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? "")
      .join("\n");
  }

  it("returns the approval in the gated call's own result", async () => {
    process.env.CAELO_MCP_APPROVAL_WAIT_MS = "5000";
    decision = "applied";
    approvalPolls = 0;
    const client = await connect();
    const r = await client.callTool({ name: "propose_delete_layout", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(texts(r)).toContain("APPROVED and applied");
    expect(approvalPolls).toBeGreaterThanOrEqual(2);
    await client.close();
  });

  it("returns a rejection with the operator's reason", async () => {
    process.env.CAELO_MCP_APPROVAL_WAIT_MS = "5000";
    decision = "rejected";
    approvalPolls = 0;
    const client = await connect();
    const r = await client.callTool({ name: "propose_delete_layout", arguments: {} });
    expect(texts(r)).toContain("REJECTED");
    expect(texts(r)).toContain("wrong layout");
    await client.close();
  });

  it("times out to a pending result and caelo_await_approval picks the decision up", async () => {
    process.env.CAELO_MCP_APPROVAL_WAIT_MS = "0";
    decision = "applied";
    approvalPolls = 0;
    const client = await connect();
    const first = await client.callTool({ name: "propose_delete_layout", arguments: {} });
    expect(texts(first)).toContain("Still waiting");
    expect(texts(first)).toContain(PROPOSAL_ID);

    process.env.CAELO_MCP_APPROVAL_WAIT_MS = "5000";
    const listed = await client.listTools();
    expect(listed.tools.some((t) => t.name === "caelo_await_approval")).toBe(true);
    const later = await client.callTool({
      name: "caelo_await_approval",
      arguments: { proposalId: PROPOSAL_ID },
    });
    expect(texts(later)).toContain("APPROVED and applied");
    await client.close();
  });
});
