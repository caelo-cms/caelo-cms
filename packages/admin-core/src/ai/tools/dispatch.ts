// SPDX-License-Identifier: MPL-2.0

/**
 * Generic tool dispatcher. AI tool-call events from the provider stream
 * land here; the dispatcher validates the JSON payload against the
 * tool's Zod schema and invokes the handler with a typed input.
 *
 * One result-shape across every tool: success returns a string the LLM
 * can read back as the tool result; failure returns an error string +
 * the message hint that landed at the boundary. Errors don't throw —
 * they flow back to the model so it can correct course.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo/query-api";
import type { ChatSendMessageInput, ExecutionContext } from "@caelo/shared";
import type { z } from "zod";

import type { AIProvider } from "../provider.js";

/**
 * P10.5 — the spawn_subagent tool handler invokes the SAME runChatTurn
 * that handled the parent. Rather than coupling the tool-dispatcher to
 * the chat-runner's full signature, the parent's chat-runner instance
 * puts this factory on the ToolContext so the handler can spawn a
 * child turn without a circular import.
 */
export type SpawnChildChatTurn = (input: {
  readonly chatInput: ChatSendMessageInput;
  readonly aiCtx: ExecutionContext;
  readonly humanCtx: ExecutionContext;
  readonly excludedToolNames: ReadonlySet<string>;
  readonly abortSignal?: AbortSignal;
}) => AsyncIterable<unknown>;

export interface ToolContext {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  /** Set when the tool runs inside a chat session — propagates to
   * snapshot emission so the AI's writes land on the chat's branch. */
  readonly chatSessionId?: string;
  readonly chatBranchId?: string;
  /**
   * P10.5 — provider + tools + humanCtx the parent's chat-runner is
   * currently using. The spawn handler reuses them when invoking
   * runChatTurn for the child. Optional: tool dispatch from outside
   * a chat-runner (tests) leaves them undefined; spawn tools fail
   * cleanly when called outside a chat-runner context.
   */
  readonly provider?: AIProvider;
  readonly tools?: ToolRegistry;
  readonly humanCtx?: ExecutionContext;
  /** Hands off to runChatTurn; closure created by the parent's runner. */
  readonly spawnChildChatTurn?: SpawnChildChatTurn;
}

export interface ToolResult {
  readonly ok: boolean;
  readonly content: string;
}

export interface ToolDefinitionWithHandler<I> {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<I>;
  /** JSON Schema for the provider — Zod doesn't ship this directly so we
   * hand-author next to the schema. Easier to keep aligned than to install
   * a Zod-to-JSON-Schema dependency for two tools. */
  readonly inputSchema: Record<string, unknown>;
  readonly handler: (ctx: ExecutionContext, input: I, toolCtx: ToolContext) => Promise<ToolResult>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinitionWithHandler<unknown>>();

  register<I>(tool: ToolDefinitionWithHandler<I>): void {
    this.#tools.set(tool.name, tool as ToolDefinitionWithHandler<unknown>);
  }

  get(name: string): ToolDefinitionWithHandler<unknown> | undefined {
    return this.#tools.get(name);
  }

  /** Provider-shaped tool catalogue for `GenerateInput.tools`. */
  catalogue(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
    return [...this.#tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async dispatch(
    name: string,
    rawArgs: unknown,
    ctx: ExecutionContext,
    toolCtx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.#tools.get(name);
    if (!tool) {
      return { ok: false, content: `unknown tool: ${name}` };
    }
    const parsed = tool.schema.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        ok: false,
        content: `invalid arguments for ${name}: ${JSON.stringify(parsed.error.issues)}`,
      };
    }
    return await tool.handler(ctx, parsed.data, toolCtx);
  }
}
