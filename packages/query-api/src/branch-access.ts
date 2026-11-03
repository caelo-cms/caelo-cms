// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #569 — branch visibility, enforced at the one place every op passes.
 *
 * A chat branch holds unpublished work. Callers name the branch they want
 * to read or write in two ways: `ExecutionContext.chatBranchId` (the
 * branch-aware read/write mode every op honours) and an op input field
 * `chatBranchId` (e.g. `pages.render_preview`). Routes fill both from
 * request data (`/edit/preview/<page>?branch=<id>`, a form field), so the
 * adapter checks every named branch against the caller before the handler
 * runs: whoever cannot see the branch gets {@link branchNotFound} — the
 * same answer as for a branch that does not exist, so a guessed id
 * confirms nothing.
 *
 * The rule itself (shared draft: everyone; any other branch: the owner of
 * a chat bound to it or a holder of `drafts.view_all`; AI: what its chat's
 * owner may see; system/plugin: always) lives in the SQL function
 * `caelo_branch_visible` (migration 0249), next to the RLS policies, and
 * reads the same `caelo.*` session vars they do.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import type { QueryError } from "./errors.js";
import type { TransactionRunner } from "./operation.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every branch id the call names: the context's branch plus an input's
 * top-level `chatBranchId`. Deduplicated; empty strings name nothing.
 */
export function namedBranches(ctx: ExecutionContext, input: unknown): string[] {
  const out = new Set<string>();
  if (ctx.chatBranchId) out.add(ctx.chatBranchId);
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const fromInput = (input as { chatBranchId?: unknown }).chatBranchId;
    if (typeof fromInput === "string" && fromInput.length > 0) out.add(fromInput);
  }
  return [...out];
}

/** The error a caller gets for a branch it may not see (or that does not exist). */
export function branchNotFound(operation: string, chatBranchId: string): QueryError {
  return {
    kind: "BranchNotFound",
    operation,
    chatBranchId,
    message:
      `branch not found: ${chatBranchId} — no chat branch with this id is visible to you. ` +
      "Use your own chat's branch (or the shared draft); another editor's experiment or migration " +
      "branch is only visible to its owner and to roles with the drafts.view_all permission.",
  };
}

/**
 * The first named branch that is not even shaped like a branch id, or
 * null. `execute()` answers it as {@link branchNotFound} BEFORE the op's
 * Zod schema runs: otherwise `?branch=not-a-uuid` would come back as a
 * validation failure and be distinguishable from "not found".
 */
export function firstMalformedBranch(branches: readonly string[]): string | null {
  return branches.find((b) => !UUID_RE.test(b)) ?? null;
}

/**
 * Issue #1392 — the visibility verdicts of one request, so a request that
 * runs many ops on the same branch asks the database once per branch.
 *
 * One MCP tool call or one preview runs dozens of ops (36 in one
 * `inspect_page_render`), each in its own short transaction, and each
 * asked `caelo_branch_visible` again — the most frequent statement under
 * load on a db-f1-micro (2026-11-03 measurements). The verdict depends on
 * the caller (actor kind, actor, chat task) and the branch, so within one
 * request it is asked once: the first lookup's promise is shared by every
 * concurrent op of the request (a `Promise.all` of reads asks once too).
 *
 * The memory lives only inside {@link withBranchVisibilityScope} — the
 * admin opens one scope per HTTP request — and dies with it, so a verdict
 * never reaches another request (a requestId would not do: callers reuse
 * one per chat session or plugin, and a client may send its own). Inside a
 * long request (a chat turn, a stream) a verdict is asked again after
 * {@link VERDICT_MAX_AGE_MS}. Outside a scope nothing is remembered. The
 * rule itself stays in SQL (migration 0249).
 */
const VERDICT_MAX_AGE_MS = 30_000;

interface VisibilityScope {
  readonly verdicts: Map<string, { readonly visible: Promise<boolean>; readonly at: number }>;
}

const visibilityScope = new AsyncLocalStorage<VisibilityScope>();

/**
 * Run `fn` with a branch-visibility memory of its own (one per HTTP
 * request in the admin). Nested scopes keep the outer one.
 */
export function withBranchVisibilityScope<T>(fn: () => T): T {
  if (visibilityScope.getStore()) return fn();
  return visibilityScope.run({ verdicts: new Map() }, fn);
}

function verdictKey(ctx: ExecutionContext, branch: string): string {
  return `${ctx.actorKind}|${ctx.actorId}|${ctx.chatTaskId ?? ""}|${branch}`;
}

/** The scope's fresh verdict promise for `branch`, or undefined. */
function rememberedVerdict(ctx: ExecutionContext, branch: string): Promise<boolean> | undefined {
  const scope = visibilityScope.getStore();
  if (!scope) return undefined;
  const key = verdictKey(ctx, branch);
  const hit = scope.verdicts.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > VERDICT_MAX_AGE_MS) {
    scope.verdicts.delete(key);
    return undefined;
  }
  return hit.visible;
}

/** Share `visible` with the rest of the scope; a failed ask is forgotten. */
function rememberVerdict(ctx: ExecutionContext, branch: string, visible: Promise<boolean>): void {
  const scope = visibilityScope.getStore();
  if (!scope) return;
  const key = verdictKey(ctx, branch);
  const entry = { visible, at: Date.now() };
  scope.verdicts.set(key, entry);
  visible.catch(() => {
    if (scope.verdicts.get(key) === entry) scope.verdicts.delete(key);
  });
}

/**
 * The verdict for `branches` from the request's memory alone: the first
 * invisible branch, null when all are visible, or undefined when any is
 * not remembered (the database must be asked). No transaction needed.
 */
export async function rememberedFirstInvisible(
  ctx: ExecutionContext,
  branches: readonly string[],
): Promise<string | null | undefined> {
  const pending: { branch: string; visible: Promise<boolean> }[] = [];
  for (const branch of branches) {
    if (!UUID_RE.test(branch)) return branch;
    const visible = rememberedVerdict(ctx, branch);
    if (!visible) return undefined;
    pending.push({ branch, visible });
  }
  for (const p of pending) {
    try {
      if (!(await p.visible)) return p.branch;
    } catch {
      return undefined; // the ask that was shared failed: ask again
    }
  }
  return null;
}

/**
 * Check the branches a call names against the caller, inside the call's
 * transaction (the `caelo.*` session vars are already set). Returns the
 * first branch the caller may not see, or null when all are visible.
 * With the caller's `ctx`, a verdict the request already has (or is
 * asking for) is reused, and a new one is shared with the request.
 */
export async function firstInvisibleBranch(
  tx: TransactionRunner,
  branches: readonly string[],
  ctx?: ExecutionContext,
): Promise<string | null> {
  for (const branch of branches) {
    // A malformed id names no branch; refusing it here also keeps the
    // uuid cast below from turning into a HandlerError.
    if (!UUID_RE.test(branch)) return branch;
    let visible = ctx ? rememberedVerdict(ctx, branch) : undefined;
    if (!visible) {
      visible = (async () => {
        const rows = (await tx.execute(
          sql`SELECT caelo_branch_visible(${branch}::uuid) AS visible`,
        )) as unknown as { visible: boolean }[];
        return rows[0]?.visible === true;
      })();
      if (ctx) rememberVerdict(ctx, branch, visible);
    }
    if (!(await visible)) return branch;
  }
  return null;
}
