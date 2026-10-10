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
 * Check the branches a call names against the caller, inside the call's
 * transaction (the `caelo.*` session vars are already set). Returns the
 * first branch the caller may not see, or null when all are visible.
 */
export async function firstInvisibleBranch(
  tx: TransactionRunner,
  branches: readonly string[],
): Promise<string | null> {
  for (const branch of branches) {
    // A malformed id names no branch; refusing it here also keeps the
    // uuid cast below from turning into a HandlerError.
    if (!UUID_RE.test(branch)) return branch;
    const rows = (await tx.execute(
      sql`SELECT caelo_branch_visible(${branch}::uuid) AS visible`,
    )) as unknown as { visible: boolean }[];
    if (rows[0]?.visible !== true) return branch;
  }
  return null;
}
