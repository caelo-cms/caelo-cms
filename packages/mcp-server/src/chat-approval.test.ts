// SPDX-License-Identifier: MPL-2.0
/**
 * Issue #658 — caelo_chat: a turn that paused on approval cards surfaces
 * them, waits for the operator's decision, and continues the agent's OWN
 * turn (`resumeApprovals`) with the outcome; past the bound it says how to
 * keep waiting. Real MCP SDK client over an in-memory transport against a
 * stub admin.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type ChatApprovalState,
  describeWaiting,
  type SendChatResult,
  settleChatApprovals,
} from "./chat-approval.js";
import { startMcpServer } from "./server.js";

const CHAT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CARD = { approvalId: "ap-1", toolName: "propose_create_mcp_token", preview: "Mint a token" };

function reply(assistant: string, pending = false): SendChatResult {
  return {
    chatSessionId: CHAT,
    requestId: `r-${assistant.length}`,
    assistant,
    toolCalls: [],
    pendingProposals: 0,
    costMicrocents: 10,
    pendingApprovals: pending ? [CARD] : [],
  };
}

function state(s: ChatApprovalState["state"], approved: boolean | null = null): ChatApprovalState {
  return {
    state: s,
    approvals:
      s === "none"
        ? []
        : [
            {
              ...CARD,
              status:
                s === "pending"
                  ? "pending"
                  : s === "superseded"
                    ? "superseded"
                    : approved
                      ? "approved"
                      : "rejected",
              approved,
              reason: approved === false ? "not now" : null,
            },
          ],
  };
}

describe("settleChatApprovals", () => {
  it("waits for the decision, then resumes the agent's turn once", async () => {
    const seq = [state("pending"), state("pending"), state("decided", true)];
    let polls = 0;
    let resumes = 0;
    const r = await settleChatApprovals({
      chatSessionId: CHAT,
      fetchState: async () => seq[Math.min(polls++, seq.length - 1)] as ChatApprovalState,
      resume: async () => {
        resumes++;
        return reply("Token minted.");
      },
      waitMs: 60_000,
      resumeReserveMs: 30_000,
      sleep: async () => {},
    });
    expect(r.kind).toBe("settled");
    expect(resumes).toBe(1);
    expect(r.turns.map((t) => t.assistant)).toEqual(["Token minted."]);
  });

  it("never resumes before every card is decided — a timeout returns pending", async () => {
    let t = 0;
    let resumes = 0;
    const r = await settleChatApprovals({
      chatSessionId: CHAT,
      fetchState: async () => state("pending"),
      resume: async () => {
        resumes++;
        return reply("x");
      },
      waitMs: 9_000,
      resumeReserveMs: 0,
      intervalMs: 3_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(r.kind).toBe("pending");
    expect(resumes).toBe(0);
  });

  it("does not start a resume that would outlive the call's budget (codex review)", async () => {
    let t = 0;
    let resumes = 0;
    const r = await settleChatApprovals({
      chatSessionId: CHAT,
      fetchState: async () => state("decided", true),
      // The first resume takes 25 s and pauses again; a second 30 s resume
      // would no longer fit in the 50 s call.
      resume: async () => {
        resumes++;
        t += 25_000;
        return reply("paused again", true);
      },
      waitMs: 50_000,
      resumeReserveMs: 30_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(r.kind).toBe("ready");
    expect(resumes).toBe(1);
  });

  it("checks the budget on the first read too: a decision read late does not resume", async () => {
    let t = 0;
    let resumes = 0;
    const r = await settleChatApprovals({
      chatSessionId: CHAT,
      // The read itself takes 6 s of a 35 s budget: a 30 s resume no longer fits.
      fetchState: async () => {
        t += 6_000;
        return state("decided", true);
      },
      resume: async () => {
        resumes++;
        return reply("x");
      },
      waitMs: 35_000,
      resumeReserveMs: 30_000,
      now: () => t,
    });
    expect(r.kind).toBe("ready");
    expect(resumes).toBe(0);
  });

  it("stops waiting for a decision while a resume still fits", async () => {
    let t = 0;
    const r = await settleChatApprovals({
      chatSessionId: CHAT,
      fetchState: async () => state("pending"),
      resume: async () => reply("never"),
      waitMs: 50_000,
      resumeReserveMs: 30_000,
      intervalMs: 3_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(r.kind).toBe("pending");
    expect(t).toBe(20_000);
  });

  it("resumes at once when the decision is already there on the first read", async () => {
    let resumes = 0;
    const r = await settleChatApprovals({
      chatSessionId: CHAT,
      fetchState: async () => state("decided", false),
      resume: async () => {
        resumes++;
        return reply("ok");
      },
      waitMs: 35_000,
      resumeReserveMs: 30_000,
    });
    expect(r.kind).toBe("settled");
    expect(resumes).toBe(1);
  });

  it("reports a card a newer message dropped", async () => {
    const r = await settleChatApprovals({
      chatSessionId: CHAT,
      fetchState: async () => state("superseded"),
      resume: async () => reply("never"),
      waitMs: 1_000,
      resumeReserveMs: 0,
    });
    expect(r.kind).toBe("superseded");
  });

  it("the waiting note names the next step and forbids re-sending", () => {
    const note = describeWaiting(CHAT, [CARD]);
    expect(note).toContain("caelo_await_approval");
    expect(note).toContain(CHAT);
    expect(note).toContain("Do not send the request again");
  });
});

describe("caelo_chat over the chat MCP server", () => {
  let stub: ReturnType<typeof Bun.serve>;
  let decision: "pending" | "approved" | "rejected" = "pending";
  let statePolls = 0;
  let resumeBodies: unknown[] = [];
  const prevWait = process.env.CAELO_MCP_APPROVAL_WAIT_MS;
  const prevTimeout = process.env.CAELO_MCP_TIMEOUT_MS;

  beforeAll(() => {
    // A short HTTP timeout keeps the resume reserve inside the 5 s waits below.
    process.env.CAELO_MCP_TIMEOUT_MS = "1000";
    stub = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        if (path === "/api/mcp/chat") {
          if (body.resumeApprovals === true) {
            resumeBodies.push(body);
            return Response.json(
              reply(decision === "approved" ? "Minted the token." : "Understood, not minting it."),
            );
          }
          return Response.json(reply("I'll mint that token.", true));
        }
        if (path === "/api/mcp/chat/approval") {
          statePolls++;
          // The operator decides after the agent started waiting.
          if (statePolls < 2 || decision === "pending") return Response.json(state("pending"));
          return Response.json(state("decided", decision === "approved"));
        }
        return new Response("not found", { status: 404 });
      },
    });
  });

  afterAll(() => {
    stub.stop(true);
    if (prevTimeout === undefined) delete process.env.CAELO_MCP_TIMEOUT_MS;
    else process.env.CAELO_MCP_TIMEOUT_MS = prevTimeout;
  });
  afterEach(() => {
    if (prevWait === undefined) delete process.env.CAELO_MCP_APPROVAL_WAIT_MS;
    else process.env.CAELO_MCP_APPROVAL_WAIT_MS = prevWait;
  });

  async function connect(): Promise<Client> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await startMcpServer({
      adminUrl: `http://127.0.0.1:${stub.port}`,
      token: "mcp_test",
      transport: serverSide,
      approvalPollMs: 5,
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);
    return client;
  }

  function texts(r: Awaited<ReturnType<Client["callTool"]>>): string[] {
    return (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "");
  }

  it("returns the decision and the continued turn in the caelo_chat result itself", async () => {
    process.env.CAELO_MCP_APPROVAL_WAIT_MS = "5000";
    decision = "approved";
    statePolls = 0;
    resumeBodies = [];
    const client = await connect();
    const r = await client.callTool({
      name: "caelo_chat",
      arguments: { message: "Mint a token." },
    });
    const [text, meta] = texts(r);
    expect(text).toContain("I'll mint that token.");
    expect(text).toContain("The operator APPROVED propose_create_mcp_token");
    expect(text).toContain("Minted the token.");
    expect(JSON.parse(meta ?? "{}").pendingApprovals).toEqual([]);
    expect(resumeBodies).toEqual([{ chatSessionId: CHAT, resumeApprovals: true }]);
    await client.close();
  });

  it("times out to a waiting result, and caelo_await_approval continues the turn after a Reject", async () => {
    process.env.CAELO_MCP_APPROVAL_WAIT_MS = "0";
    decision = "pending";
    statePolls = 0;
    resumeBodies = [];
    const client = await connect();
    const first = await client.callTool({ name: "caelo_chat", arguments: { message: "Mint." } });
    const [text, meta] = texts(first);
    expect(text).toContain("caelo_await_approval");
    expect(JSON.parse(meta ?? "{}").pendingApprovals).toEqual([
      { approvalId: "ap-1", toolName: "propose_create_mcp_token" },
    ]);
    expect(resumeBodies).toEqual([]);

    process.env.CAELO_MCP_APPROVAL_WAIT_MS = "5000";
    decision = "rejected";
    const listed = await client.listTools();
    expect(listed.tools.some((t) => t.name === "caelo_await_approval")).toBe(true);
    const later = await client.callTool({
      name: "caelo_await_approval",
      arguments: { chatSessionId: CHAT },
    });
    const [laterText] = texts(later);
    expect(laterText).toContain("REJECTED");
    expect(laterText).toContain("not now");
    expect(laterText).toContain("Understood, not minting it.");
    expect(resumeBodies).toHaveLength(1);
    await client.close();
  });
});
