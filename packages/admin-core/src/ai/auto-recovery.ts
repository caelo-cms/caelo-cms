// SPDX-License-Identifier: MPL-2.0

/**
 * v0.6.0 W3 — auto-recovery for tool dispatches that returned
 * `ToolResult.nextAction.autoExecute === true`. Lifted out of the
 * chat-runner's per-tool-call loop in alpha.4 Fix W so the brace
 * nesting is readable + the retry shape can be tested in isolation.
 *
 * Flow:
 *   1. Dispatch the suggested recovery tool (must be read-only — name
 *      prefix `list_` / `get_` or suffix `.get` / `_get`).
 *   2. If recovery succeeded AND `nextAction.retryWithArgs` is set
 *      AND the recovery returned a structured `value` AND a value
 *      resolves at the named path AND the rewritten args validate
 *      against the original tool's Zod schema:
 *        re-dispatch the ORIGINAL tool with the corrected args.
 *        On retry success: AI sees a clean success (with an
 *        `[auto-recovered: ...]` marker).
 *        On retry failure: fall through to fold-into-content.
 *   3. Otherwise: fold the recovery output into the original failure
 *      content + return ok:false so the AI handles retry on its next
 *      turn.
 *
 * Bounded to ONE retry per dispatch. The recovery tool itself does
 * NOT participate in auto-recovery (no recursion).
 */

import type { ExecutionContext } from "@caelo-cms/shared";

import type { ToolContext, ToolRegistry, ToolResult } from "./tools/dispatch.js";

export interface AutoRecoverInput {
  /** The original failed dispatch result. Must have `ok=false` and a
   * non-empty `nextAction.autoExecute`. */
  readonly failed: ToolResult;
  /** The original tool call (name + parsed-from-stream arguments). */
  readonly originalCall: { readonly name: string; readonly arguments: unknown };
  /** Tool registry the chat-runner is using. */
  readonly tools: ToolRegistry;
  /** AI ctx the original tool call ran with. The recovery + retry use
   * the same ctx so audit / branch tagging stay consistent. */
  readonly aiCtx: ExecutionContext;
  /** Tool dispatch context (adapter, registry, chat session, etc.).
   * Reused verbatim for both the recovery + retry dispatches. */
  readonly toolCtx: ToolContext;
  /** Chat session id for log correlation. */
  readonly chatSessionId: string;
}

/**
 * Run the auto-recovery flow. Returns the new ToolResult to surface
 * back to the chat-runner (which then proceeds with persistence +
 * yield + downstream message append as normal). Always returns a
 * value — never throws; on internal failure returns the original
 * `failed` result unchanged so the caller's flow is identical.
 */
export async function tryAutoRecover(input: AutoRecoverInput): Promise<ToolResult> {
  const { failed, originalCall, tools, aiCtx, toolCtx, chatSessionId } = input;
  const nextAction = failed.nextAction;
  if (!nextAction?.autoExecute) return failed;

  const recoveryToolName = nextAction.tool;
  if (!isReadOnlyToolName(recoveryToolName)) return failed;
  if (tools.get(recoveryToolName) === undefined) return failed;

  let recovery: ToolResult;
  try {
    const recoveryArgs = nextAction.args ?? {};
    recovery = await tools.dispatch(recoveryToolName, recoveryArgs, aiCtx, toolCtx);
  } catch (err) {
    console.error("[chat-runner.auto-recovery] recovery dispatch threw", {
      chatSessionId,
      recoveryTool: recoveryToolName,
      error: err,
    });
    return failed;
  }

  const recoveryStatus = recovery.ok ? "ok" : "fail";
  const retrySpec = nextAction.retryWithArgs;

  // No retry path → fold recovery output into failure content. AI
  // handles retry on its next turn.
  if (!recovery.ok || !retrySpec || recovery.value === undefined) {
    return foldRecoveryIntoFailure({ failed, recovery, recoveryToolName, recoveryStatus });
  }

  // Resolve the rewriter path. Empty → fold.
  const extracted = extractAtPath(recovery.value, retrySpec.fromValuePath);
  if (extracted === undefined) {
    return foldRecoveryIntoFailure({ failed, recovery, recoveryToolName, recoveryStatus });
  }

  // Build rewritten args + validate against the ORIGINAL tool's
  // schema. Catches misconfigured retryWithArgs (wrong argName, wrong
  // path shape) before re-dispatch so the AI doesn't see a confusing
  // "invalid arguments" error from a tool it called with valid args.
  const originalArgs = (originalCall.arguments ?? {}) as Record<string, unknown>;
  const rewrittenArgs = { ...originalArgs, [retrySpec.argName]: extracted };
  const originalToolDef = tools.get(originalCall.name);
  const validation = originalToolDef?.schema.safeParse(rewrittenArgs);
  if (!validation?.success) {
    console.error("[chat-runner.auto-recovery] retry rewritten args failed schema", {
      chatSessionId,
      tool: originalCall.name,
      retrySpec,
      issues: validation?.success === false ? validation.error.issues : null,
    });
    return {
      ok: false,
      content: clip(
        `${failed.content}\n\n[auto-recovery] ${recoveryToolName} (ok): ${recovery.content}\n[retry skipped — rewritten args failed schema; check the tool's retryWithArgs spec]`,
      ),
    };
  }

  // All checks passed — re-dispatch the ORIGINAL tool with corrected
  // args. AI sees a clean success on its next turn (with an explicit
  // [auto-recovered: ...] marker for transparency).
  let retried: ToolResult;
  try {
    retried = await tools.dispatch(originalCall.name, rewrittenArgs, aiCtx, toolCtx);
  } catch (err) {
    console.error("[chat-runner.auto-recovery] retry dispatch threw", {
      chatSessionId,
      originalTool: originalCall.name,
      error: err,
    });
    return foldRecoveryIntoFailure({ failed, recovery, recoveryToolName, recoveryStatus });
  }

  if (retried.ok) {
    return {
      ok: true,
      content: clip(
        `${retried.content}\n[auto-recovered: ${recoveryToolName} fetched ${retrySpec.argName}=${String(extracted).slice(0, 80)} and re-dispatched ${originalCall.name}]`,
      ),
      ...(retried.image ? { image: retried.image } : {}),
    };
  }

  // Retry also failed — surface both attempts to the AI so it sees
  // the corrected attempt's actual error (often more informative than
  // the original failure).
  return {
    ok: false,
    content: clip(
      `${failed.content}\n\n[auto-recovery] ${recoveryToolName} (ok): ${recovery.content}\n[retry] ${originalCall.name} with ${retrySpec.argName}=${String(extracted).slice(0, 80)} → ${retried.content}`,
    ),
  };
}

function foldRecoveryIntoFailure(args: {
  failed: ToolResult;
  recovery: ToolResult;
  recoveryToolName: string;
  recoveryStatus: string;
}): ToolResult {
  const { failed, recovery, recoveryToolName, recoveryStatus } = args;
  return {
    ok: false,
    content: clip(
      `${failed.content}\n\n[auto-recovery] ${recoveryToolName} (${recoveryStatus}): ${recovery.content}`,
    ),
  };
}

function clip(s: string): string {
  return s.length > 8000 ? s.slice(0, 8000) : s;
}

/**
 * Read-only by naming convention. The auto-recovery flow ONLY fires
 * on tools whose name matches this predicate, so a misconfigured
 * `nextAction.tool` pointing at a write tool can't trigger an
 * unwanted side-effect.
 */
function isReadOnlyToolName(name: string): boolean {
  return (
    name.startsWith("list_") ||
    name.startsWith("get_") ||
    name.endsWith(".get") ||
    name.endsWith("_get")
  );
}

/**
 * Declarative path extraction for the W3 retry path. Resolves
 * dot-separated paths against a structured `value` payload returned
 * by a recovery tool. Supports numeric indices for arrays
 * (e.g. "layouts.0.id" → value.layouts[0].id). Returns undefined when
 * any segment misses.
 *
 * Pure data extraction — no execution, no eval, no JSONPath. Each
 * segment is a property name OR a non-negative integer index.
 */
export function extractAtPath(value: unknown, path: string): unknown {
  if (value === null || value === undefined) return undefined;
  const segments = path.split(".").filter((s) => s.length > 0);
  let current: unknown = value;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = Number.parseInt(segment, 10);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}
