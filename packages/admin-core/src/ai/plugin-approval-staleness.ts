// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1705 — before the Owner is asked to approve a draft-bound plugin
 * tool (`approvedOnChatBranch`), make sure the click can apply.
 *
 * Such a call runs on the chat's branch after the click, so its writes of
 * the plugin's rows go through the shared draft's conflict check (#620): a
 * row another chat changed since this chat last saw it refuses the write.
 * Found only then, the approval was spent on nothing and the Owner had to
 * approve again after the AI re-read and re-proposed.
 *
 * The host cannot know which rows the plugin's operation will write, but
 * the call names what it is about: the ids among its arguments
 * (`allow_external_embed`'s `moduleId`). So this names the plugin's rows
 * about those ids that another chat changed and this chat has not seen
 * (`plugins.unseen_draft_rows`), and the card is not shown until the AI has
 * read them with the read a conflict names. Rows the plugin's own change
 * consumer re-derived are no chat's change and never named (locks.ts). A
 * row the call writes that names none of the ids, and whatever changes
 * after the card is shown, still refuses at the apply: an approval never
 * overwrites a change the chat did not see.
 *
 * Expressed like the shape preflight (`chat-runner/approval-preflight.ts`):
 * in the chat a declined `tool-approval-response`, over MCP an unqueued
 * call, with this text for the AI. No card, no operator decision.
 */

import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { describeError } from "./tools/_describe-error.js";

/** Rows the refusal names one by one; the read takes them all. */
const ROWS_NAMED = 5;

/** Ids one check looks for (the op's bound). */
const MAX_ENTITY_IDS = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ids among a call's arguments: top-level values and arrays of them. */
export function idsInArgs(args: unknown): string[] {
  if (typeof args !== "object" || args === null) return [];
  const out = new Set<string>();
  for (const v of Object.values(args)) {
    for (const item of Array.isArray(v) ? v : [v]) {
      if (typeof item === "string" && UUID_RE.test(item)) out.add(item.toLowerCase());
    }
  }
  return [...out].slice(0, MAX_ENTITY_IDS);
}

/**
 * Why the approval card for this plugin call must not be shown yet, or null
 * when it may (nothing unseen, or no draft chat to be stale in).
 *
 * @param input.aiCtx the proposing chat's AI context (branch + task)
 * @param input.toolName the gated tool, as the refusal names it
 * @param input.args the call's arguments: the ids among them say which rows it is about
 */
export async function stalePluginViewBeforeApproval(input: {
  readonly registry: OperationRegistry;
  readonly adapter: DatabaseAdapter;
  readonly aiCtx: ExecutionContext;
  readonly pluginSlug: string;
  readonly toolName: string;
  /** The call's arguments, as the card would show them. */
  readonly args: unknown;
}): Promise<string | null> {
  if (!input.aiCtx.chatBranchId || !input.aiCtx.chatTaskId) return null;
  const entityIds = idsInArgs(input.args);
  if (entityIds.length === 0) return null;
  const r = await execute(input.registry, input.adapter, input.aiCtx, "plugins.unseen_draft_rows", {
    pluginSlug: input.pluginSlug,
    entityIds,
  });
  if (!r.ok) {
    // The apply still checks every row it writes; a failed read here must
    // not block a proposal it cannot rule out (as the shape preflight).
    console.error("[approval-staleness] could not read the plugin's unseen draft rows", {
      plugin: input.pluginSlug,
      error: describeError(r.error),
    });
    return null;
  }
  const rows = (
    r.value as {
      rows: { id: string; table: string; changedAt: string; changedByChat: string }[];
    }
  ).rows;
  if (rows.length === 0) return null;
  const named = rows
    .slice(0, ROWS_NAMED)
    .map((row) => `${row.table} ${row.id} by chat '${row.changedByChat}' (${row.changedAt})`)
    .join("; ");
  const more = rows.length > ROWS_NAMED ? ` and ${rows.length - ROWS_NAMED} more` : "";
  return (
    `${input.toolName} was NOT shown to the operator: another chat changed the plugin "${input.pluginSlug}"'s records about what this call names, in the shared draft after this chat last looked at them (${named}${more}), ` +
    "so the approved call could not apply. " +
    `Read them with get_plugin_draft_rows({rowIds:${JSON.stringify(rows.map((row) => row.id))}}), check they do not change what you propose, then call ${input.toolName} again. ` +
    "Do not ask the operator about this — no approval was requested and none is pending."
  );
}
