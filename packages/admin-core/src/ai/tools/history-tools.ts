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
import { snapshotsListInput } from "@caelo-cms/shared";
import { z } from "zod";
import type { listPendingChangesOp } from "../../ops/chat/stage.js";
import type { getSnapshotWithEntitiesOp } from "../../ops/snapshots/get.js";
import type { moduleImpactOp } from "../../ops/snapshots/impact.js";
import type { listSnapshotsOp } from "../../ops/snapshots/list.js";
import { describeError } from "./_describe-error.js";
import { makeListReadTool, makeReadTool } from "./_make-read-tool.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

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

const noInput = z.object({}).strict();

export const listUnpublishedChangesTool: ToolDefinitionWithHandler<Record<string, never>> = {
  name: "list_unpublished_changes",
  description:
    "List what THIS chat session changed that is not published yet — pages, site-wide pieces (modules, templates, layouts, theme) and lists — split into not-yet-staged and already staged. " +
    "Use before telling the operator the work is ready to publish, to summarise what publishing will ship, or to check an edit landed on the branch.",
  schema: noInput,
  inputSchema: z.toJSONSchema(noInput) as Record<string, unknown>,
  handler: async (ctx, _input, toolCtx) => {
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
    const render = (state: string, group: string, refs: readonly ChangeRef[]) =>
      refs.map((c) => `${state} ${group} ${c.kind} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
    const lines = [
      ...render("pending", "page", v.pending.pages),
      ...render("pending", "global", v.pending.globals),
      ...render("pending", "list", v.pending.lists),
      ...render("staged", "page", v.staged.pages),
      ...render("staged", "global", v.staged.globals),
      ...render("staged", "list", v.staged.lists),
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
