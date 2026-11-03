// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1260 — record the draft entities a read tool showed the AI.
 *
 * A draft conflict (`locks.ts`, shared draft #620) names the tool that
 * re-reads the entity; only a read recorded here counts as "this chat has
 * seen the change" (`chat.observe_draft_reads`). Read tools declare what
 * they showed with `draftReads`; the dispatcher records it after a
 * successful call, so no tool handler has to remember to.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import type { DraftReadKind } from "../../locks.js";
import { DRAFT_READS_MAX } from "../../ops/chat/draft-reads.js";
import { describeError } from "./_describe-error.js";
import type { ToolContext } from "./dispatch.js";

/** Entities of one kind a read showed in full. */
export interface DraftRead {
  readonly kind: DraftReadKind;
  readonly ids: readonly string[];
}

/** `{ <key>: { id } }` from a get op's value — the shape most of them return. */
export function idOf(value: unknown, key: string): string[] {
  const row = (value as Record<string, { id?: unknown } | null | undefined> | undefined)?.[key];
  return typeof row?.id === "string" ? [row.id] : [];
}

/** The ids of `{ <key>: [{ id }] }` from a list op's value. */
export function idsOf(value: unknown, key: string): string[] {
  const rows = (value as Record<string, unknown> | undefined)?.[key];
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => (typeof r?.id === "string" ? [r.id as string] : []));
}

/**
 * Record `reads` for the caller's chat. A call outside a chat records
 * nothing (no draft to conflict in).
 *
 * @param seenAt when the read began, so a change committed during the read
 *   still counts as unseen.
 * @returns null when recorded, else the note to append to the tool result:
 *   the read itself succeeded, but a later write may still be refused.
 */
export async function recordDraftReads(
  ctx: ExecutionContext,
  toolCtx: Pick<ToolContext, "registry" | "adapter">,
  reads: readonly DraftRead[],
  seenAt: string,
): Promise<string | null> {
  if (!ctx.chatBranchId || !ctx.chatTaskId) return null;
  const chunks = reads.flatMap((r) => {
    const ids = [...new Set(r.ids)];
    const out: { kind: DraftReadKind; ids: string[] }[] = [];
    for (let i = 0; i < ids.length; i += DRAFT_READS_MAX) {
      out.push({ kind: r.kind, ids: ids.slice(i, i + DRAFT_READS_MAX) });
    }
    return out;
  });
  if (chunks.length === 0) return null;
  for (const chunk of chunks) {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "chat.observe_draft_reads", {
      seenAt,
      reads: [chunk],
    });
    if (!r.ok) {
      console.error("[draft-reads] could not record a draft read", {
        kind: chunk.kind,
        error: describeError(r.error),
      });
      return `\n(Note: this read could not be recorded as seen — ${describeError(r.error)}. A write of these ${chunk.kind} entities may report a draft conflict; read again then.)`;
    }
  }
  return null;
}
