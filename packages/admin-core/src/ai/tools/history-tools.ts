// SPDX-License-Identifier: MPL-2.0

/**
 * History + blast-radius reads (agent-tool parity, part 2). The agent could
 * propose reverts (propose_revert_site / _page / _template / _module) but not
 * see the timeline it was reverting along, what a snapshot held, which pages
 * a module edit reaches, or which of its own edits are still unpublished.
 * Each tool here is a read over an op that already admits the AI actor; the
 * Advanced History drawer and the chat's pending-changes picker render the
 * same ops.
 */

import { execute } from "@caelo-cms/query-api";
import { type ExecutionContext, snapshotsListInput } from "@caelo-cms/shared";
import { z } from "zod";
import type { listOpenChangesOp } from "../../ops/chat/open-changes.js";
import type { listPendingChangesOp } from "../../ops/chat/stage.js";
import type { getSnapshotWithEntitiesOp } from "../../ops/snapshots/get.js";
import type { moduleImpactOp } from "../../ops/snapshots/impact.js";
import type { listSnapshotsOp } from "../../ops/snapshots/list.js";
import { describeError } from "./_describe-error.js";
import { makeListReadTool, makeReadTool } from "./_make-read-tool.js";
import type { ToolContext, ToolDefinitionWithHandler, ToolResult } from "./dispatch.js";

type OpValue<O extends { output: z.ZodType }> = z.infer<O["output"]>;

const uuid = z.string().uuid();

/** Per-entity characters of snapshot state shown before truncating. */
const STATE_PREVIEW_CHARS = 240;
/** Entities shown per kind in get_snapshot. */
const ENTITIES_PER_KIND = 25;

const snapshotFilters = snapshotsListInput
  .pick({
    before: true,
    forModuleId: true,
    forPageId: true,
    forTemplateId: true,
    includeArchived: true,
  })
  .partial()
  .strict();

export const listSnapshotsTool = makeListReadTool<
  z.infer<typeof snapshotFilters>,
  OpValue<typeof listSnapshotsOp>["snapshots"][number]
>({
  name: "list_snapshots",
  description:
    "List the site's edit history (snapshots), newest first: id, when, what kind of change, how many modules/templates/pages it touched. " +
    "Filter to one module / page / template, or page backwards with `before` (ISO time). " +
    "Use to find the snapshotId a propose_revert_* tool needs, or to answer 'what changed on this page lately?'. Inspect one with get_snapshot.",
  opName: "snapshots.list",
  input: snapshotFilters,
  buildOpInput: (input) => {
    const { filter: _f, limit, offset, full: _full, ...filters } = input;
    return { ...filters, limit: Math.min(200, (offset ?? 0) + (limit ?? 50)) };
  },
  rows: (value) => (value as OpValue<typeof listSnapshotsOp>).snapshots,
  label: "snapshots",
  columns: [
    { key: "id", value: (s) => s.id },
    { key: "createdAt", value: (s) => s.createdAt },
    { key: "opKind", value: (s) => s.opKind },
    {
      key: "touched",
      value: (s) => `m${s.moduleCount}/t${s.templateCount}/p${s.pageCount}/pl${s.pageLayoutCount}`,
    },
    { key: "fromChat", value: (s) => (s.chatBranchId ? "yes" : "") },
    { key: "description", value: (s) => s.description },
  ],
  emptyMessage: "No snapshots match.",
});

/** A short human label from a snapshot state blob (slug / title / name). */
function stateLabel(state: unknown): string {
  if (!state || typeof state !== "object") return "";
  const s = state as Record<string, unknown>;
  for (const k of ["slug", "title", "displayName", "display_name", "name"]) {
    if (typeof s[k] === "string") return s[k] as string;
  }
  return "";
}

function statePreview(state: unknown): string {
  const json = JSON.stringify(state) ?? "null";
  return json.length > STATE_PREVIEW_CHARS ? `${json.slice(0, STATE_PREVIEW_CHARS)}…` : json;
}

export const getSnapshotTool = makeReadTool({
  name: "get_snapshot",
  description:
    "Inspect one snapshot: its description, author and chat, and the state it recorded for each module, template, page and page layout it touched (labels + a truncated state preview). " +
    "Use before proposing a revert to confirm the snapshot holds the version the operator means. Find ids with list_snapshots.",
  opName: "snapshots.get_with_entities",
  input: z.object({ snapshotId: uuid }).strict(),
  // Full entity states can be large; the formatted preview is what the model needs.
  includeValue: false,
  format: (value) => {
    const v = value as OpValue<typeof getSnapshotWithEntitiesOp>;
    const lines = [
      `snapshot ${v.snapshot.id} at ${v.snapshot.createdAt} by ${v.snapshot.actorId}: ${v.snapshot.description}` +
        (v.snapshot.revertOf ? ` (revert of ${v.snapshot.revertOf})` : ""),
    ];
    const kinds: [string, { entityId: string; state: unknown }[]][] = [
      ["module", v.modules],
      ["template", v.templates],
      ["page", v.pages],
      ["pageLayout", v.pageLayouts],
    ];
    for (const [kind, rows] of kinds) {
      for (const r of rows.slice(0, ENTITIES_PER_KIND)) {
        const label = stateLabel(r.state);
        lines.push(`${kind} ${r.entityId}${label ? ` (${label})` : ""}: ${statePreview(r.state)}`);
      }
      if (rows.length > ENTITIES_PER_KIND) {
        lines.push(`… ${rows.length - ENTITIES_PER_KIND} more ${kind} entries`);
      }
    }
    return lines.join("\n");
  },
});

export const getModuleImpactTool = makeReadTool({
  name: "get_module_impact",
  description:
    "Blast radius of editing one module: every live page that places it (page slug, template, block) plus a severity (low / medium / high) and the reasons. " +
    "Use BEFORE editing a module that may be shared (header, footer, CTA) to tell the operator what else changes, or to decide whether to fork_placement_content instead.",
  opName: "snapshots.module_impact",
  input: z.object({ moduleId: uuid }).strict(),
  format: (value) => {
    const v = value as OpValue<typeof moduleImpactOp>;
    const lines = [
      `severity ${v.severity}: ${v.reasons.join("; ") || "no notable reasons"} — ${v.affectedPages.length} page placement(s)`,
    ];
    for (const p of v.affectedPages.slice(0, 50)) {
      lines.push(`${p.pageSlug} (template ${p.templateSlug}, block ${p.blockName})`);
    }
    if (v.affectedPages.length > 50) lines.push(`… ${v.affectedPages.length - 50} more`);
    return lines.join("\n");
  },
});

type ChangeRef = OpValue<typeof listPendingChangesOp>["pending"]["pages"][number];

const unpublishedInput = z
  .object({
    allChats: z
      .boolean()
      .optional()
      .describe(
        "true = every open chat's unstaged changes and held entities (all editors), not only this chat's.",
      ),
  })
  .strict();

const renderRefs = (state: string, group: string, refs: readonly ChangeRef[]): string[] =>
  refs.map((c) => `${state} ${group} ${c.kind} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);

/** Issue #620 — the Open changes overview as text, one block per chat. */
async function renderOpenChanges(ctx: ExecutionContext, toolCtx: ToolContext): Promise<ToolResult> {
  // The operator's ctx: "isMine" compares chat owners with the caller, and
  // the AI ctx's actor is not the operator in every runtime.
  const r = await execute(
    toolCtx.registry,
    toolCtx.adapter,
    toolCtx.humanCtx ?? ctx,
    "chat.list_open_changes",
    {},
  );
  if (!r.ok) {
    return { ok: false, content: `chat.list_open_changes failed: ${describeError(r.error)}` };
  }
  const v = r.value as OpValue<typeof listOpenChangesOp>;
  if (v.chats.length === 0) {
    return {
      ok: true,
      content: "No open changes — no chat has unstaged work or holds anything.",
      value: v,
    };
  }
  const blocks = v.chats.map((c) => {
    const head =
      `chat '${c.title}' (${c.chatSessionId})${c.chatSessionId === toolCtx.chatSessionId ? " [this chat]" : ""}` +
      `${c.isMine ? "" : " [another editor]"}${c.anchorPageSlug ? ` on /${c.anchorPageSlug}` : ""}: ` +
      `${c.pendingCount} unstaged change(s), ${c.locks.length} held entit${c.locks.length === 1 ? "y" : "ies"}`;
    return [
      head,
      ...renderRefs("  pending", "page", c.changes.pending.pages),
      ...renderRefs("  pending", "global", c.changes.pending.globals),
      ...renderRefs("  pending", "list", c.changes.pending.lists),
      ...c.locks.map((l) => `  holds ${l.entityKind} ${l.label}`),
    ].join("\n");
  });
  return {
    ok: true,
    content:
      `${blocks.join("\n")}\n` +
      "Draft chats share their changes; an item held on an experiment/older chat branch is adopted when you write it (you are told). Stage with stage_changes (scope all_my_chats for everything of the operator); the operator can also stage or discard chats at /content/changes.",
    value: v,
  };
}

export const listUnpublishedChangesTool: ToolDefinitionWithHandler<
  z.infer<typeof unpublishedInput>
> = {
  name: "list_unpublished_changes",
  description:
    "List what THIS chat session changed that is not published yet — pages, site-wide pieces (modules, templates, layouts, theme) and lists — split into not-yet-staged and already staged. " +
    "Use before telling the operator the work is ready to publish, to summarise what publishing will ship, or to check an edit landed on the branch. " +
    "With allChats: true it lists EVERY open chat's unstaged changes and the entities each holds (all editors) — use it when the operator asks what is still open across chats, or before touching something another chat may be working on.",
  schema: unpublishedInput,
  inputSchema: z.toJSONSchema(unpublishedInput) as Record<string, unknown>,
  handler: async (ctx, input, toolCtx) => {
    if (input.allChats) return renderOpenChanges(ctx, toolCtx);
    if (!toolCtx.chatSessionId) {
      return {
        ok: false,
        content:
          "list_unpublished_changes needs a chat session — open one with caelo_open_session first.",
      };
    }
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "chat.list_pending_changes", {
      chatSessionId: toolCtx.chatSessionId,
    });
    if (!r.ok) {
      return { ok: false, content: `chat.list_pending_changes failed: ${describeError(r.error)}` };
    }
    const v = r.value as OpValue<typeof listPendingChangesOp>;
    const lines = [
      ...renderRefs("pending", "page", v.pending.pages),
      ...renderRefs("pending", "global", v.pending.globals),
      ...renderRefs("pending", "list", v.pending.lists),
      ...renderRefs("staged", "page", v.staged.pages),
      ...renderRefs("staged", "global", v.staged.globals),
      ...renderRefs("staged", "list", v.staged.lists),
    ];
    return {
      ok: true,
      content:
        lines.length > 0
          ? lines.join("\n")
          : "Nothing unpublished — this chat has no changes waiting to publish.",
      value: v,
    };
  },
};
