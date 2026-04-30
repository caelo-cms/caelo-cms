// SPDX-License-Identifier: MPL-2.0

/**
 * P10.5 — `spawn_subagent` (single) and `spawn_subagents` (plural).
 *
 * A subagent is just a chat-runner turn. The handler:
 *   1. Creates an ephemeral chat_sessions row (with subagent_role
 *      flagged; the sidebar filters these out).
 *   2. Calls runChatTurn (via toolCtx.spawnChildChatTurn) with:
 *        - the new chat session id,
 *        - excludedToolNames = {spawn_subagent, spawn_subagents}
 *          (depth cap = 1, expressed as plain configuration),
 *        - parent attribution on aiCtx (parent_chat_session_id +
 *          parent_ai_call_id flow into ai_calls writes),
 *      and consumes the AsyncIterable to completion (or timeout).
 *   3. Reads the subagent's final assistant message via chat.get_session.
 *   4. Parses against the spec's expectedReturnShape.
 *   5. Persists a subagent_runs metadata row.
 *   6. Returns the parsed result as the parent's tool_result.
 *
 * No special "subagent runtime." Same chat-runner code path. The skill
 * matcher inside the subagent engages whichever skill the task message
 * scores highest against.
 */

import { execute } from "@caelo/query-api";
import {
  parseSubagentResult,
  type SpawnSubagentsToolInput,
  type SpawnSubagentToolInput,
  spawnSubagentsToolInput,
  spawnSubagentToolInput,
} from "@caelo/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const EXCLUDED_FOR_CHILD = new Set(["spawn_subagent", "spawn_subagents"]);
const SUBAGENT_BATCH_CAP_MICROCENTS = Number(
  process.env["SUBAGENT_BATCH_CAP_MICROCENTS"] ?? "200000000", // $2.00 default
);
const SUBAGENT_MAX_PARALLEL = Number(process.env["SUBAGENT_MAX_PARALLEL"] ?? "8");

interface SubagentInvocationResult {
  role: string;
  status: "completed" | "errored" | "timed_out";
  resultJson: unknown;
  costMicrocents: number;
  durationMs: number;
  subagentChatSessionId: string;
  errorMessage?: string;
}

async function runOneSubagent(
  spec: SpawnSubagentToolInput,
  ctx: Parameters<ToolDefinitionWithHandler<unknown>["handler"]>[0],
  toolCtx: Parameters<ToolDefinitionWithHandler<unknown>["handler"]>[2],
  batchId: string,
  parentAiCallId: string | null,
): Promise<SubagentInvocationResult> {
  const startedAt = Date.now();

  if (!toolCtx.adapter || !toolCtx.registry || !toolCtx.spawnChildChatTurn || !toolCtx.humanCtx) {
    return {
      role: spec.role,
      status: "errored",
      resultJson: null,
      costMicrocents: 0,
      durationMs: 0,
      subagentChatSessionId: "",
      errorMessage:
        "spawn_subagent invoked outside a chat-runner context (no provider/registry/spawn factory available)",
    };
  }

  // 1. Create ephemeral chat session for the subagent.
  const sessionR = await execute(
    toolCtx.registry,
    toolCtx.adapter,
    toolCtx.humanCtx,
    "chat.create_session",
    {
      title: `[subagent] ${spec.role}`,
      subagentRole: spec.role,
      parentChatSessionId: toolCtx.chatSessionId ?? null,
    },
  );
  if (!sessionR.ok) {
    return {
      role: spec.role,
      status: "errored",
      resultJson: null,
      costMicrocents: 0,
      durationMs: Date.now() - startedAt,
      subagentChatSessionId: "",
      errorMessage: `failed to create subagent chat session: ${describeError(sessionR.error)}`,
    };
  }
  const subagentChatSessionId = (sessionR.value as { chatSessionId: string }).chatSessionId;

  // 2. Persist a pending subagent_runs row up front so the Owner UI
  //    sees it immediately even if the run hangs.
  const runRow = await execute(
    toolCtx.registry,
    toolCtx.adapter,
    ctx,
    "subagent_runs.create_pending",
    {
      parentChatSessionId: toolCtx.chatSessionId ?? null,
      parentMessageId: null, // not threaded through ToolContext today
      subagentChatSessionId,
      batchId,
      role: spec.role,
      task: spec.task,
    },
  );
  const subagentRunId = runRow.ok ? (runRow.value as { id: string }).id : null;

  // 3. Invoke runChatTurn for the child. The spawn factory closes over
  //    the parent's provider + tools registry so we don't need to
  //    rebuild them here.
  const childAiCtx = {
    ...ctx,
    parentChatSessionId: toolCtx.chatSessionId ?? undefined,
    parentAiCallId: parentAiCallId ?? undefined,
  };
  const childHumanCtx = toolCtx.humanCtx;

  // Per-spec timeout via AbortController.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), spec.timeoutMs);
  let timedOut = false;

  try {
    const stream = toolCtx.spawnChildChatTurn({
      chatInput: {
        chatSessionId: subagentChatSessionId,
        content: spec.task,
        chips: [],
        ...(spec.activePageId ? { activePageId: spec.activePageId } : {}),
      },
      aiCtx: childAiCtx,
      humanCtx: childHumanCtx,
      excludedToolNames: EXCLUDED_FOR_CHILD,
      abortSignal: controller.signal,
    });
    // Drain the AsyncIterable to completion. We don't care about
    // intermediate events here — the spawn handler's job is to wait
    // for the run to finish; the parent stream surfaces a single
    // verdicts event after Promise.all resolves.
    for await (const ev of stream as AsyncIterable<{ kind: string }>) {
      if (controller.signal.aborted) {
        timedOut = true;
        break;
      }
      void ev;
    }
  } catch (e) {
    clearTimeout(timer);
    const message = (e as Error).message;
    if (subagentRunId) {
      await execute(toolCtx.registry, toolCtx.adapter, ctx, "subagent_runs.finish", {
        id: subagentRunId,
        status: "errored",
        resultJson: null,
        costMicrocents: 0,
        durationMs: Date.now() - startedAt,
        errorMessage: message,
      });
    }
    return {
      role: spec.role,
      status: "errored",
      resultJson: null,
      costMicrocents: 0,
      durationMs: Date.now() - startedAt,
      subagentChatSessionId,
      errorMessage: message,
    };
  } finally {
    clearTimeout(timer);
  }

  // 4. Read the subagent's final assistant message.
  const sessGet = await execute(
    toolCtx.registry,
    toolCtx.adapter,
    toolCtx.humanCtx,
    "chat.get_session",
    {
      chatSessionId: subagentChatSessionId,
    },
  );
  let finalText = "";
  if (sessGet.ok) {
    const messages = (
      sessGet.value as {
        messages: { role: string; content: string }[];
      }
    ).messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant" && messages[i]?.content) {
        finalText = messages[i]?.content ?? "";
        break;
      }
    }
  }

  if (timedOut) {
    if (subagentRunId) {
      await execute(toolCtx.registry, toolCtx.adapter, ctx, "subagent_runs.finish", {
        id: subagentRunId,
        status: "timed_out",
        resultJson: null,
        costMicrocents: 0,
        durationMs: Date.now() - startedAt,
        errorMessage: `subagent timed out after ${spec.timeoutMs}ms`,
      });
    }
    return {
      role: spec.role,
      status: "timed_out",
      resultJson: null,
      costMicrocents: 0,
      durationMs: Date.now() - startedAt,
      subagentChatSessionId,
      errorMessage: `subagent timed out after ${spec.timeoutMs}ms`,
    };
  }

  // 5. Parse against the spec's expectedReturnShape. On failure, return
  //    the raw text under freeform shape for parent visibility.
  const parsed = parseSubagentResult(finalText, spec.expectedReturnShape);
  let resultJson: unknown;
  let status: "completed" | "errored" = "completed";
  let errorMessage: string | undefined;
  if (parsed.ok) {
    resultJson = parsed.value;
  } else {
    status = "errored";
    errorMessage = parsed.error;
    resultJson = { raw: finalText.slice(0, 4000) };
  }

  // 6. Roll up the subagent's accumulated cost from ai_calls.
  const costR = await execute(
    toolCtx.registry,
    toolCtx.adapter,
    toolCtx.humanCtx,
    "ai_calls.aggregate_for_session",
    {
      chatSessionId: subagentChatSessionId,
    },
  );
  const costMicrocents = costR.ok ? (costR.value as { costMicrocents: number }).costMicrocents : 0;

  if (costMicrocents > spec.maxCostMicrocents) {
    status = "errored";
    errorMessage = `subagent exceeded cost cap: spent ${costMicrocents} / cap ${spec.maxCostMicrocents}`;
  }

  if (subagentRunId) {
    await execute(toolCtx.registry, toolCtx.adapter, ctx, "subagent_runs.finish", {
      id: subagentRunId,
      status,
      resultJson: resultJson as Record<string, unknown>,
      costMicrocents,
      durationMs: Date.now() - startedAt,
      errorMessage: errorMessage ?? null,
    });
  }

  return {
    role: spec.role,
    status,
    resultJson,
    costMicrocents,
    durationMs: Date.now() - startedAt,
    subagentChatSessionId,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function summarize(results: SubagentInvocationResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const cost = (r.costMicrocents / 1e8).toFixed(4);
    if (r.status === "completed") {
      lines.push(
        `## ${r.role} (completed · ${r.durationMs}ms · $${cost})\n${JSON.stringify(r.resultJson, null, 2)}`,
      );
    } else {
      lines.push(
        `## ${r.role} (${r.status}${r.errorMessage ? ` — ${r.errorMessage}` : ""} · ${r.durationMs}ms · $${cost})`,
      );
    }
  }
  return lines.join("\n\n");
}

export const spawnSubagentTool: ToolDefinitionWithHandler<SpawnSubagentToolInput> = {
  name: "spawn_subagent",
  description:
    "Spawn ONE subagent to take a fresh, focused angle on a task — its own context window + tool catalogue + auto-engaged skill. The subagent's matcher engages whichever skill its task wording scores highest against (e.g. role='qa', task='QA the new article' → engages qa-check). " +
    "Use spawn_subagents (plural) when you need MULTIPLE angles in parallel. Single is for one-off deeper-research tasks where you don't have multiple to fan out. " +
    "BLOCKS until the subagent finishes (typical: 5-30s). Returns the subagent's parsed verdict + cost + duration. Subagents are read-only by default (allowedToolNames defaults exclude writes). " +
    "DO NOT use for one-line edits or quick lookups — use a regular tool. Subagents earn their cost when work is multi-step + needs an isolated reasoning context.",
  schema: spawnSubagentToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["role", "task"],
    properties: {
      role: { type: "string", minLength: 1, maxLength: 120 },
      task: { type: "string", minLength: 1, maxLength: 8000 },
      allowedToolNames: { type: "array", items: { type: "string", maxLength: 120 } },
      expectedReturnShape: { type: "string", enum: ["verdict", "tree", "freeform"] },
      maxCostMicrocents: { type: "integer", minimum: 0 },
      timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
      activePageId: { type: "string", format: "uuid" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const batchId = crypto.randomUUID();
    const result = await runOneSubagent(input, ctx, toolCtx, batchId, null);
    return {
      ok: result.status === "completed",
      content: summarize([result]),
    };
  },
};

export const spawnSubagentsTool: ToolDefinitionWithHandler<SpawnSubagentsToolInput> = {
  name: "spawn_subagents",
  description:
    "Spawn MULTIPLE subagents in parallel. Each subagent gets its own context window + auto-engaged skill (matcher fires inside each subagent based on its task wording). All subagents run concurrently; this tool BLOCKS until all finish. " +
    "Use this when a task benefits from multiple angles in parallel — e.g. drafting an article and validating it via QA + legal + brand-voice review (3 parallel verdicts), or auditing a structure via a current-state auditor + a fresh-proposal generator (2 parallel angles). " +
    "Returns ONE bundled tool result with each subagent's parsed verdict + cost + duration, keeping the prompt-cache prefix clean. Subagents are read-only by default. " +
    "Cap: 8 parallel subagents per call. Each subagent has its own per-spawn cost cap (default $0.50) + timeout (default 60s); the batch overall is capped at $2.00 unless overridden via env.",
  schema: spawnSubagentsToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["subagents"],
    properties: {
      subagents: {
        type: "array",
        minItems: 1,
        maxItems: SUBAGENT_MAX_PARALLEL,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["role", "task"],
          properties: {
            role: { type: "string", minLength: 1, maxLength: 120 },
            task: { type: "string", minLength: 1, maxLength: 8000 },
            allowedToolNames: { type: "array", items: { type: "string", maxLength: 120 } },
            expectedReturnShape: { type: "string", enum: ["verdict", "tree", "freeform"] },
            maxCostMicrocents: { type: "integer", minimum: 0 },
            timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
            activePageId: { type: "string", format: "uuid" },
          },
        },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    if (input.subagents.length > SUBAGENT_MAX_PARALLEL) {
      return {
        ok: false,
        content: `spawn_subagents max parallel = ${SUBAGENT_MAX_PARALLEL}; got ${input.subagents.length}`,
      };
    }
    const batchId = crypto.randomUUID();
    const results = await Promise.all(
      input.subagents.map((spec) => runOneSubagent(spec, ctx, toolCtx, batchId, null)),
    );
    const totalCost = results.reduce((sum, r) => sum + r.costMicrocents, 0);
    if (totalCost > SUBAGENT_BATCH_CAP_MICROCENTS) {
      return {
        ok: false,
        content:
          `spawn_subagents batch cost cap exceeded: spent ${totalCost} / cap ${SUBAGENT_BATCH_CAP_MICROCENTS}\n\n` +
          summarize(results),
      };
    }
    const allCompleted = results.every((r) => r.status === "completed");
    return { ok: allCompleted, content: summarize(results) };
  },
};
