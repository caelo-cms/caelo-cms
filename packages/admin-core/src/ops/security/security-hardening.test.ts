// SPDX-License-Identifier: MPL-2.0

import { describe, expect, test } from "bun:test";
import type { DatabaseAdapter, ExecutionContext, TransactionRunner } from "@caelo-cms/query-api";
import { markChatMessageInterruptedOp, setResponseMessagesOp } from "../chat/messages.js";
import { claimTurnApprovalsOp } from "../chat/turn-approvals.js";
import { listMcpApprovalHandoffsOp } from "../mcp_approval_handoffs.js";
import { getSubagentRunOp, listSubagentRunsOp } from "../subagents/runs.js";
import { mcpTokenAuthErrorMessage, resolveMcpToken } from "./mcp_tokens.js";

const ACTOR_A = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";

const HUMAN_CTX: ExecutionContext = {
  actorId: ACTOR_A,
  actorKind: "human",
  requestId: "req-test-1",
};

describe("MCP token RBAC & auth error messages", () => {
  test("formats user_lacks_write_permission with actionable guidance", () => {
    const msg = mcpTokenAuthErrorMessage("user_lacks_write_permission");
    expect(msg).toContain("auth_error: token user_lacks_write_permission");
    expect(msg).toContain("content.write");
  });

  test("resolveMcpToken rejects tokens owned by read-only users without content.write", async () => {
    const fakeAdapter: DatabaseAdapter = {
      hasPermission: async () => false,
      withAdminTransaction: async (_ctx, fn) => {
        const tx: TransactionRunner = {
          execute: async () => [
            {
              id: "44444444-4444-4444-8444-444444444444",
              actor_id: ACTOR_A,
              display_name: "Reviewer token",
              scope: "admin",
              ai_cost_cap_microcents: null,
              allow_caelo_ai: false,
              expires_at: new Date(Date.now() + 60_000),
              revoked_at: null,
              user_active: true,
              user_has_role: true,
              user_can_write: false,
            },
          ],
        };
        return fn(tx);
      },
      withPublicTransaction: async () => {
        throw new Error("unused");
      },
      close: async () => {},
    };

    const res = await resolveMcpToken(fakeAdapter, "caelo_mcp_test_secret");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("user_lacks_write_permission");
    }
  });
});

describe("claimTurnApprovalsOp access & approver permission enforcement", () => {
  test("refuses human actor who does not own the chat session and lacks settings.write", async () => {
    const queries: string[] = [];
    const tx: TransactionRunner = {
      execute: async (q) => {
        const text = JSON.stringify(q);
        queries.push(text);
        if (text.includes("FROM chat_sessions")) {
          // Session owned by someone else
          return [{ created_by: "99999999-9999-4999-8999-999999999999" }];
        }
        // approverRefusal permission check returns no permissions
        return [];
      },
    };

    const res = await claimTurnApprovalsOp.handler(
      HUMAN_CTX,
      {
        chatSessionId: SESSION_ID,
        source: "live_edit",
        decision: { approvalId: "ap-1", approved: true },
      },
      tx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("not found among your chats");
    }
  });

  test("refuses live_edit approval when human lacks the tool's required_permissions", async () => {
    let callCount = 0;
    const tx: TransactionRunner = {
      execute: async () => {
        callCount += 1;
        if (callCount === 1) {
          // chatAccessRefusal: session owned by HUMAN_CTX.actorId
          return [{ created_by: ACTOR_A }];
        }
        if (callCount === 2) {
          // SELECT FROM chat_turn_approvals FOR UPDATE
          return [
            {
              source: "live_edit",
              status: "pending",
              tool_name: "propose_PluginInstall",
              required_permissions: ["plugins.manage"],
            },
          ];
        }
        // approverRefusal: actor holds only content.write, not plugins.manage
        return [{ name: "content.write" }];
      },
    };

    const res = await claimTurnApprovalsOp.handler(
      HUMAN_CTX,
      {
        chatSessionId: SESSION_ID,
        source: "live_edit",
        decision: { approvalId: "ap-1", approved: true },
      },
      tx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("plugins.manage");
    }
  });
});

describe("chat message & observability cross-operator scoping", () => {
  test("setResponseMessagesOp and markChatMessageInterruptedOp scope human updates to own session", async () => {
    const queries: string[] = [];
    const tx: TransactionRunner = {
      execute: async (q) => {
        queries.push(JSON.stringify(q));
        return [];
      },
    };

    const setRes = await setResponseMessagesOp.handler(
      HUMAN_CTX,
      { messageId: MESSAGE_ID, responseMessages: [{ role: "assistant", content: "hi" }] },
      tx,
    );
    expect(setRes.ok).toBe(false);
    expect(queries[0]).toContain("chat_sessions");
    expect(queries[0]).toContain("created_by");

    await markChatMessageInterruptedOp.handler(HUMAN_CTX, { messageId: MESSAGE_ID }, tx);
    expect(queries[1]).toContain("chat_sessions");
    expect(queries[1]).toContain("created_by");
  });

  test("listMcpApprovalHandoffsOp and subagent_runs ops scope non-Owner human queries", async () => {
    const queries: string[] = [];
    const tx: TransactionRunner = {
      execute: async (q) => {
        queries.push(JSON.stringify(q));
        return [];
      },
    };

    await listMcpApprovalHandoffsOp.handler(HUMAN_CTX, {}, tx);
    expect(queries.some((q) => q.includes("requested_by"))).toBe(true);

    queries.length = 0;
    await listSubagentRunsOp.handler(HUMAN_CTX, { limit: 10 }, tx);
    expect(queries.some((q) => q.includes("chat_sessions"))).toBe(true);

    queries.length = 0;
    await getSubagentRunOp.handler(HUMAN_CTX, { id: SESSION_ID }, tx);
    expect(queries.some((q) => q.includes("chat_sessions"))).toBe(true);
  });
});
