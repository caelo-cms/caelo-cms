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

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ChatSendMessageInput, ExecutionContext } from "@caelo-cms/shared";
import type { z } from "zod";

import type { AIProvider } from "../provider.js";
import type { ToolDescribeState } from "./describe-state.js";

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
  /** P10.5 #3 — per-spawn cost cap propagated to runChatTurn. */
  readonly costCapMicrocents?: number;
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
  /**
   * P10.5 #1 — async-event sink installed by the parent's chat-runner
   * around each tool dispatch. The spawn_subagent handler pushes the
   * child's events here as they arrive; the parent's generator drains
   * the queue between provider events so the user sees subagent
   * progress LIVE instead of a frozen wait. Tool handlers that don't
   * push (every other tool) just leave it untouched.
   */
  readonly pushClientEvent?: (event: unknown) => void;
  /**
   * v0.3.1 — browser-mediated screenshot tool needs to wait for the
   * operator's browser to capture + upload the image. When set, the
   * tool can register itself with this orchestrator: it generates a
   * requestId, the orchestrator returns a Promise that resolves when
   * the SSE upload endpoint receives the image, and yields the
   * `request-screenshot` SSE event so ChatPanel can perform the
   * capture. Undefined when the tool is invoked outside an SSE chat
   * (background workers, MCP, tests).
   */
  readonly requestScreenshot?: (req: {
    pageId: string;
    chatBranchId?: string;
    viewport?: "desktop" | "tablet" | "mobile";
    timeoutMs?: number;
  }) => Promise<{ base64: string; mediaType: "image/png" }>;
}

export interface ToolResult {
  readonly ok: boolean;
  readonly content: string;
  /**
   * v0.3.0 — optional image attached to the result. When set, the
   * chat-runner builds a follow-up multimodal user message
   * (containing this image + a small "tool returned image" hint
   * text) on the NEXT provider call, so the AI can reason over the
   * image alongside the textual result. Used by `screenshot_page`.
   */
  readonly image?: {
    base64: string;
    mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  };
  /**
   * v0.6.0 W3 — structured recovery hint propagated from
   * `QueryError.HandlerError.nextAction`. When set with
   * `autoExecute: true` AND the chat-runner recognises the suggested
   * tool as read-only (catalogue prefix `list_*`, suffix `*.get`),
   * the runner dispatches the recovery tool BEFORE yielding the
   * failed tool-result to the AI and concatenates the recovery
   * output into `content` so the AI sees the failure + the data it
   * would have asked for on its next turn in one round-trip.
   *
   * v0.6.0 alpha.2 — when `retryWithArgs` is also set AND the
   * recovery returns a structured `value`, the chat-runner extracts
   * the named field from `value` and re-dispatches the ORIGINAL
   * tool with the argument injected. The AI never sees the failure
   * (one round-trip vs. two). Bounded to one retry per call.
   *
   * Tool handlers populate this by reading
   * `result.error.nextAction` from the failed QueryError and
   * copying the fields verbatim via `forwardNextAction(error)`.
   */
  readonly nextAction?: {
    readonly tool: string;
    readonly args?: Record<string, unknown>;
    readonly reason: string;
    readonly autoExecute?: boolean;
    /**
     * v0.6.0 alpha.2 — declarative arg-rewriter for the original-call
     * retry. After the recovery succeeds, the chat-runner extracts
     * `recovery.value` at `fromValuePath` (dot-separated, supports
     * numeric indices like "layouts.0.id") and sets it as `argName`
     * on the original tool's args, then re-dispatches once.
     */
    readonly retryWithArgs?: {
      readonly argName: string;
      readonly fromValuePath: string;
    };
  };
  /**
   * v0.6.0 alpha.2 — optional structured payload alongside the prose
   * `content`. Consumed by the chat-runner's W3 retry path: when the
   * recovery returns this, the runner extracts a field via
   * `nextAction.retryWithArgs.fromValuePath` and rewrites the
   * original args. Tools that don't expect to be on a recovery path
   * leave this undefined; list_* / *.get tools should populate it.
   */
  readonly value?: unknown;
}

/**
 * JSON Schema (draft-07-ish) object handed to the AI provider for a tool's
 * arguments. Hand-authored next to each tool's Zod schema (we don't ship a
 * zod-to-json-schema dep). Aliased so the per-turn `describeSchema` hook and
 * the static `inputSchema` share one self-documenting contract.
 */
export type ToolInputSchema = Record<string, unknown>;

export interface ToolDefinitionWithHandler<I> {
  readonly name: string;
  /** Static fallback description. Used when `describe()` is absent, when
   * state-builder fails, or for telemetry / non-AI surfaces (catalogue
   * page, tests). */
  readonly description: string;
  /** v0.6.0 W1 — optional state-aware description. When set AND a
   * `ToolDescribeState` is passed to `catalogue()`, this callback's
   * return value replaces the static description in the per-turn AI
   * call. Lets tools surface live preconditions ("layoutId REQUIRED
   * on fresh install", "block 'content' exists on this template")
   * instead of stale general-purpose prose. The return string is
   * sent to the model verbatim — keep it as concise as the static
   * description. Throwing from `describe()` falls back to the static
   * description silently. */
  readonly describe?: (state: ToolDescribeState) => string;
  /**
   * v0.12.3 (issue #106) — optional state-aware `inputSchema` builder.
   * When set AND a `ToolDescribeState` is passed to `catalogue()`, the
   * returned JSON Schema REPLACES the static `inputSchema` for that
   * per-turn provider call. This is the generation-time constraint lever:
   * `add_module_to_page` / `move_module` use it to narrow `blockName` to
   * an `enum` of the focused page's actual template blocks, so the model
   * cannot emit a block name that doesn't exist (CLAUDE.md §1A — constrain
   * at generation rather than guess-then-fail). The op-layer Validator
   * still rejects an out-of-set block as defense-in-depth (enum adherence
   * isn't guaranteed across providers).
   *
   * Throwing falls back to the static `inputSchema` silently (mirrors
   * `describe`). Return the FULL schema object, not a patch.
   */
  readonly describeSchema?: (state: ToolDescribeState) => ToolInputSchema;
  /**
   * v0.6.0 W5 — SDK-6-inspired approval gate. When set and returns
   * `true` for the parsed args, the dispatcher emits a structured
   * approval-required ToolResult instead of running the handler. The
   * chat-runner surfaces this to the operator (via the existing
   * ProposeCard render path) and the AI sees a "TWO-STEP — Owner must
   * click Approve" result.
   *
   * This complements caelo's existing propose/execute pattern rather
   * than replacing it. Use needsApproval for NEW tools where:
   *   - the action is hard-to-revert (CLAUDE.md §11.A criteria), AND
   *   - the propose/execute split adds more friction than the gate is
   *     worth (no audit-history value, no preview-without-execute
   *     value).
   * Existing propose/* tools stay as-is — their `*_pending_actions`
   * tables carry preview metadata + cross-chat audit history that a
   * pure predicate-gate can't replicate.
   *
   * The predicate is sync OR async; throwing from it is treated as
   * `false` (let the action through) + logs an error — never block
   * silently on a faulty predicate.
   */
  readonly needsApproval?: (input: I, ctx: ExecutionContext) => boolean | Promise<boolean>;
  /**
   * v0.6.0 W5 — when needsApproval returns true, this builder produces
   * the "blast-radius" preview shown to the operator alongside the
   * approve/reject buttons. Falls back to `{ tool, args }` when
   * absent. Use to surface the affected entity count, the diff, the
   * downstream URLs that change, etc. — same shape as
   * `*_pending_actions.preview` in the existing propose tables.
   */
  readonly buildApprovalPreview?: (
    input: I,
    ctx: ExecutionContext,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  readonly schema: z.ZodType<I>;
  /** JSON Schema for the provider — Zod doesn't ship this directly so we
   * hand-author next to the schema. Easier to keep aligned than to install
   * a Zod-to-JSON-Schema dependency for two tools. */
  readonly inputSchema: ToolInputSchema;
  readonly handler: (ctx: ExecutionContext, input: I, toolCtx: ToolContext) => Promise<ToolResult>;
}

/**
 * issue #106 (step-13 round-4) — build an AI-actionable argument-rejection
 * message instead of dumping raw Zod issues.
 *
 * When the provider emits a tool call the Zod `schema` rejects, the AI's only
 * recovery path is the error string we hand back. A raw `JSON.stringify(issues)`
 * dump ("unrecognized_keys [...]") tells the model *what* failed but not *what
 * shape to emit instead*, so it has to guess — exactly the round-trip CLAUDE.md
 * §11 ("failure surfaces are AI-actionable") and §1A (don't punt) tell us to
 * close. We translate the common Zod codes to plain instructions AND append the
 * tool's expected argument shape (required + optional property names) derived
 * from its static JSON `inputSchema`, so the model can re-emit a valid call in
 * one turn without a human round-trip.
 *
 * The static `inputSchema` is authoritative for the *key set* even when a tool
 * uses a per-turn `describeSchema` (those only narrow value enums, never the
 * allowed keys), so a key-level error like `unrecognized_keys` is always
 * described correctly here.
 */

/**
 * issue #106 (step-13 round-6, opt 5) — describe the allowed forms of a
 * polymorphic (`oneOf`/`anyOf`) argument from its JSON schema, so an
 * `invalid_union` rejection can say "expected \"top\" | \"bottom\", or an
 * integer 0..1000" instead of the bare "Invalid input" Zod emits for a union.
 * Returns null when the schema isn't a recognizable union (caller falls back
 * to the raw message).
 */
function describeAllowedForms(propSchema: unknown): string | null {
  if (!propSchema || typeof propSchema !== "object") return null;
  const branches =
    (propSchema as { oneOf?: unknown[] }).oneOf ?? (propSchema as { anyOf?: unknown[] }).anyOf;
  if (!Array.isArray(branches) || branches.length === 0) return null;
  const parts: string[] = [];
  for (const b of branches) {
    if (!b || typeof b !== "object") continue;
    const branch = b as { enum?: unknown[]; type?: string; minimum?: number; maximum?: number };
    if (Array.isArray(branch.enum)) {
      parts.push(branch.enum.map((v) => JSON.stringify(v)).join(" | "));
    } else if (branch.type === "integer" || branch.type === "number") {
      const lo = typeof branch.minimum === "number" ? branch.minimum : null;
      const hi = typeof branch.maximum === "number" ? branch.maximum : null;
      parts.push(
        lo !== null && hi !== null ? `an ${branch.type} ${lo}..${hi}` : `a ${branch.type}`,
      );
    } else if (typeof branch.type === "string") {
      parts.push(`a ${branch.type}`);
    }
  }
  return parts.length > 0 ? parts.join(", or ") : null;
}

function formatToolArgError(
  name: string,
  issues: readonly z.ZodIssue[],
  inputSchema: ToolInputSchema,
): string {
  const props = (inputSchema.properties ?? {}) as Record<string, unknown>;
  const allKeys = Object.keys(props);
  const required = Array.isArray(inputSchema.required) ? (inputSchema.required as string[]) : [];
  const optional = allKeys.filter((k) => !required.includes(k));

  const lines = issues.slice(0, 6).map((issue) => {
    const path = issue.path.join(".") || "(root)";
    switch (issue.code) {
      case "unrecognized_keys":
        return `Unrecognized argument(s): ${issue.keys
          .map((k) => `\`${k}\``)
          .join(", ")} — this tool does not accept ${
          issue.keys.length > 1 ? "those keys" : "that key"
        }.`;
      case "invalid_type":
        return `\`${path}\`: expected ${issue.expected} (${issue.message}).`;
      case "invalid_union": {
        // Zod emits a bare "Invalid input" for a failed union; surface the
        // allowed forms from the arg's JSON schema so the model can re-emit.
        const forms = describeAllowedForms(props[String(issue.path[0])]);
        return forms
          ? `\`${path}\`: invalid value — expected ${forms}.`
          : `\`${path}\`: ${issue.message} (did not match any allowed form for this argument).`;
      }
      default:
        return `\`${path}\`: ${issue.message}`;
    }
  });

  const shape =
    `Expected arguments for \`${name}\` — ` +
    `required: ${required.length ? required.map((k) => `\`${k}\``).join(", ") : "(none)"}; ` +
    `optional: ${optional.length ? optional.map((k) => `\`${k}\``).join(", ") : "(none)"}.`;

  return (
    `invalid arguments for ${name}:\n` +
    lines.map((l) => `- ${l}`).join("\n") +
    `\n${shape}\n` +
    `Re-call \`${name}\` with only the listed properties (drop any unrecognized keys) and retry — do not ask the operator.`
  );
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinitionWithHandler<unknown>>();

  register<I>(tool: ToolDefinitionWithHandler<I>): void {
    this.#tools.set(tool.name, tool as ToolDefinitionWithHandler<unknown>);
  }

  get(name: string): ToolDefinitionWithHandler<unknown> | undefined {
    return this.#tools.get(name);
  }

  /**
   * Provider-shaped tool catalogue for `GenerateInput.tools`.
   *
   * v0.6.0 W1 — when `state` is supplied, each tool's optional
   * `describe(state)` callback is invoked and its return value replaces
   * the static description. Tools without `describe()` use the static
   * description (backward-compatible). If `describe()` throws, the
   * static description is used and a console.error is emitted — never
   * propagates to the AI call.
   */
  catalogue(
    state?: ToolDescribeState,
  ): { name: string; description: string; inputSchema: ToolInputSchema }[] {
    return [...this.#tools.values()].map((t) => {
      let description = t.description;
      if (state && t.describe) {
        try {
          description = t.describe(state);
        } catch (err) {
          console.error(
            `[tool.describe] ${t.name} threw — falling back to static description`,
            err,
          );
        }
      }
      // v0.12.3 (issue #106) — per-turn inputSchema. Lets a tool narrow
      // an argument to a state-scoped enum (e.g. blockName) at generation
      // time. Falls back to the static schema if absent or on throw.
      let inputSchema = t.inputSchema;
      if (state && t.describeSchema) {
        try {
          inputSchema = t.describeSchema(state);
        } catch (err) {
          console.error(
            `[tool.describeSchema] ${t.name} threw — falling back to static inputSchema`,
            err,
          );
        }
      }
      return {
        name: t.name,
        description,
        inputSchema,
      };
    });
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
      // issue #106 — hand back an AI-actionable shape (named problem + the
      // tool's expected argument set) so the model self-corrects in one turn
      // rather than guessing or punting to the operator. See formatToolArgError.
      return {
        ok: false,
        content: formatToolArgError(name, parsed.error.issues, tool.inputSchema),
      };
    }
    // v0.6.0 W5 — approval gate. When the tool declares
    // `needsApproval(input, ctx) === true`, the dispatcher persists a
    // pending row to `tool_approval_actions` (via the `tool_approvals.queue`
    // op) and returns the canonical "Queued proposal <uuid>:" string
    // so ChatPanel's existing ProposeCard renderer parses + renders
    // the inline Approve / Reject buttons. The Approve action at
    // /security/tool-approvals/pending atomically claims the row and
    // dispatches the tool with the persisted args.
    if (tool.needsApproval) {
      let gated = false;
      try {
        gated = await tool.needsApproval(parsed.data, ctx);
      } catch (err) {
        console.error(`[tool.needsApproval] ${name} threw — letting action through`, err);
        gated = false;
      }
      if (gated) {
        let preview: Record<string, unknown> = {
          tool: name,
          args: parsed.data as Record<string, unknown>,
        };
        if (tool.buildApprovalPreview) {
          try {
            preview = await tool.buildApprovalPreview(parsed.data, ctx);
          } catch (err) {
            console.error(`[tool.buildApprovalPreview] ${name} threw — using default preview`, err);
          }
        }
        // Out-of-chat dispatches (tests, plugin-host calls) lack a
        // real adapter + registry. The persistence path requires both,
        // so we emit a deliberately NON-canonical content string
        // (no "Queued proposal <uuid>:" prefix) so ProposeCard's
        // regex `/^Queued proposal ([0-9a-f-]{36}):/` skips it and
        // never renders an Approve button that would 400 on click.
        // Production callers always have adapter + registry set by the
        // chat-runner, so this fallback only affects tests + plugin-
        // host calls; plugin-host doesn't render through ProposeCard
        // anyway, so the "no-button" outcome is fine.
        const hasContext = toolCtx.adapter !== undefined && toolCtx.registry !== undefined;
        if (!hasContext) {
          const previewSummary = JSON.stringify(preview).slice(0, 400);
          return {
            ok: true,
            content:
              `[needs-approval, non-persisted] ${name} would queue for Owner approval ` +
              `(${previewSummary}). Out-of-chat dispatch — no Approve UI available.`,
          };
        }
        // Persist via the Query API so the Approve button has
        // something to look up.
        try {
          const queueRes = await execute(
            toolCtx.registry,
            toolCtx.adapter,
            ctx,
            "tool_approvals.queue",
            {
              toolName: name,
              args: parsed.data as Record<string, unknown>,
              preview,
              ...(toolCtx.chatSessionId ? { chatSessionId: toolCtx.chatSessionId } : {}),
            },
          );
          if (queueRes.ok) {
            const proposalId = (queueRes.value as { proposalId: string }).proposalId;
            const previewSummary = JSON.stringify(preview).slice(0, 400);
            // Canonical "Queued proposal <uuid>: <summary>." shape so
            // ProposeCard's PROPOSAL_CONTENT_PATTERN regex matches +
            // renders the inline Approve / Reject card.
            return {
              ok: true,
              content:
                `Queued proposal ${proposalId}: ${name} — needs Owner approval (${previewSummary}). ` +
                `An Owner must click Approve at /security/tool-approvals/pending to apply.`,
            };
          }
          // Queue insert failed — emit a non-canonical fallback so the
          // operator sees the failure rather than silently letting the
          // gated action through.
          console.error("[tool.needsApproval] tool_approvals.queue failed", {
            tool: name,
            error: queueRes.error,
          });
          return {
            ok: false,
            content: `tool ${name} needs approval but the proposal could not be queued; refusing to run. Try again later.`,
          };
        } catch (err) {
          console.error("[tool.needsApproval] queue call threw", { tool: name, err });
          return {
            ok: false,
            content: `tool ${name} needs approval and the queue path errored; refusing to run.`,
          };
        }
      }
    }
    return await tool.handler(ctx, parsed.data, toolCtx);
  }
}
