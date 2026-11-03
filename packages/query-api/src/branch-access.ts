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
 * the caller (actor kind, actor, chat task) and the branch, and within one
 * request nothing that decides it changes, so it is kept per
 * `(requestId, caller, branch)`. Entries expire after `ttlMs` and the map
 * is bounded, so a worker that reuses one requestId re-asks at least that
 * often and a revoked permission takes effect on the next request. A
 * context without a requestId is never memoised. The rule itself stays in
 * SQL (migration 0249); this only remembers its answers.
 */
export class BranchVisibilityMemo {
  readonly #entries = new Map<string, { readonly visible: boolean; readonly at: number }>();
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;

  /**
   * @param ttlMs - how long a verdict is reused (default 30 s)
   * @param max - entries kept at most; the oldest go first (default 5,000)
   */
  constructor(opts: { ttlMs?: number; max?: number; now?: () => number } = {}) {
    this.#ttlMs = opts.ttlMs ?? 30_000;
    this.#max = opts.max ?? 5_000;
    this.#now = opts.now ?? Date.now;
  }

  static #key(ctx: ExecutionContext, branch: string): string | null {
    if (!ctx.requestId) return null;
    return `${ctx.requestId}|${ctx.actorKind}|${ctx.actorId}|${ctx.chatTaskId ?? ""}|${branch}`;
  }

  /** The remembered verdict, or undefined when the database must be asked. */
  get(ctx: ExecutionContext, branch: string): boolean | undefined {
    const key = BranchVisibilityMemo.#key(ctx, branch);
    if (key === null) return undefined;
    const hit = this.#entries.get(key);
    if (!hit) return undefined;
    if (this.#now() - hit.at > this.#ttlMs) {
      this.#entries.delete(key);
      return undefined;
    }
    return hit.visible;
  }

  /** Remember a verdict the database gave. */
  set(ctx: ExecutionContext, branch: string, visible: boolean): void {
    const key = BranchVisibilityMemo.#key(ctx, branch);
    if (key === null) return;
    this.#entries.delete(key);
    this.#entries.set(key, { visible, at: this.#now() });
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  /**
   * The verdict for `branches` from memory alone: the first invisible
   * branch, null when all are known visible, or undefined when any is
   * unknown (ask the database).
   */
  firstInvisible(ctx: ExecutionContext, branches: readonly string[]): string | null | undefined {
    for (const branch of branches) {
      if (!UUID_RE.test(branch)) return branch;
      const v = this.get(ctx, branch);
      if (v === undefined) return undefined;
      if (!v) return branch;
    }
    return null;
  }
}

/**
 * Check the branches a call names against the caller, inside the call's
 * transaction (the `caelo.*` session vars are already set). Returns the
 * first branch the caller may not see, or null when all are visible.
 * With a `memo`, verdicts this request already has are not asked again
 * and new ones are remembered.
 */
export async function firstInvisibleBranch(
  tx: TransactionRunner,
  branches: readonly string[],
  memo?: { readonly memo: BranchVisibilityMemo; readonly ctx: ExecutionContext },
): Promise<string | null> {
  for (const branch of branches) {
    // A malformed id names no branch; refusing it here also keeps the
    // uuid cast below from turning into a HandlerError.
    if (!UUID_RE.test(branch)) return branch;
    const known = memo?.memo.get(memo.ctx, branch);
    if (known === true) continue;
    if (known === false) return branch;
    const rows = (await tx.execute(
      sql`SELECT caelo_branch_visible(${branch}::uuid) AS visible`,
    )) as unknown as { visible: boolean }[];
    const visible = rows[0]?.visible === true;
    memo?.memo.set(memo.ctx, branch, visible);
    if (!visible) return branch;
  }
  return null;
}
