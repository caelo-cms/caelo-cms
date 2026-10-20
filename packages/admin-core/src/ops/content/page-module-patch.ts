// SPDX-License-Identifier: MPL-2.0

/**
 * #917 — `page_module_content.patch_fields`: change individual values of
 * ONE placement, the way Live Edit's in-place editing does. The operator
 * edits what they see; this op patches exactly those fields (or list
 * items) and leaves every other value of the placement as it is.
 *
 * Bulk-first (CLAUDE.md §11): `edits` carries one entry per changed value
 * so a link's label + target or an image + its alt text land in one call
 * and one snapshot. A single text edit is the one-element case.
 *
 * The placement is resolved through the caller's branch-overlaid layout,
 * the same view the preview renders (so the text the operator clicked is
 * the text that changes). Read + patch + write run in one transaction
 * through `content_instances.set_values` (lock, snapshot, version check),
 * so a concurrent edit of another field cannot be overwritten by a stale
 * read, and chat Undo reverts it.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import {
  loadContentInstanceStateWithBranchOverlay,
  loadModuleStateWithBranchOverlay,
  loadPageLayoutStateWithBranchOverlay,
} from "../../snapshots/index.js";
import { setContentInstanceValuesOp } from "./content-instances.js";

const OP = "page_module_content.patch_fields";

/**
 * Text fields store HTML-ready strings (the template engine substitutes
 * them unescaped), so the operator's plain text is escaped once here:
 * "Fish & chips" must not turn into an entity reference, "<3" not into a
 * tag.
 */
function escapeFieldText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const editSchema = z
  .object({
    /** Field name as the module declares it. */
    field: z.string().min(1).max(200),
    /** Item index for a `text-list` item or a `link-list` label. */
    index: z.number().int().nonnegative().optional(),
    /** Plain text as the operator typed it; escaped before storing. */
    text: z.string().max(10_000),
  })
  .strict();
type Edit = z.infer<typeof editSchema>;

type Patch = { ok: true; value: unknown } | { ok: false; message: string };

/** The field's new value with the edit applied, or a reason it cannot be. */
function applyEdit(kind: string, current: unknown, edit: Edit): Patch {
  const text = escapeFieldText(edit.text);
  if (kind === "text") {
    if (edit.index !== undefined) return { ok: false, message: "a text field takes no index" };
    return { ok: true, value: text };
  }
  if (kind !== "text-list" && kind !== "link-list") {
    return { ok: false, message: `a ${kind} field cannot be edited as plain text` };
  }
  if (edit.index === undefined) {
    return { ok: false, message: `a ${kind} field needs the item index` };
  }
  const items = Array.isArray(current) ? current : [];
  if (edit.index >= items.length) {
    return {
      ok: false,
      message: `item ${edit.index} does not exist (the list has ${items.length})`,
    };
  }
  const next = [...items];
  if (kind === "text-list") {
    next[edit.index] = text;
  } else {
    const item = items[edit.index];
    if (typeof item !== "object" || item === null) {
      return { ok: false, message: `item ${edit.index} is not a link` };
    }
    next[edit.index] = { ...item, label: text };
  }
  return { ok: true, value: next };
}

function fail(
  message: string,
  nextAction?: { tool: string; args: Record<string, unknown>; reason: string },
) {
  return err({ kind: "HandlerError" as const, operation: OP, message, nextAction });
}

export const patchPageModuleFieldsOp = defineOperation({
  name: OP,
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      pageId: z.string().uuid(),
      blockName: z.string().min(1),
      position: z.number().int().nonnegative(),
      edits: z.array(editSchema).min(1).max(20),
    })
    .strict(),
  output: z.object({ contentInstanceId: z.string(), version: z.number().int().positive() }),
  handler: async (ctx, input, tx) => {
    const layout = await loadPageLayoutStateWithBranchOverlay(
      tx,
      input.pageId,
      ctx.chatBranchId ?? null,
    );
    const placement = layout.blocks.find((b) => b.blockName === input.blockName)?.placements?.[
      input.position
    ];
    if (!placement) {
      return fail(
        `This section is no longer on the page (no placement at ${input.blockName} #${input.position}). Reload the preview and try again.`,
      );
    }
    if (placement.syncMode === "synced") {
      return fail(
        "This text is shared with other pages, so it is not edited in place. Ask the AI to change it everywhere or only on this page.",
        {
          tool: "fork_placement_content",
          args: { pageId: input.pageId, blockName: input.blockName, position: input.position },
          reason:
            "detach this placement so the edit stays on this page, or call set_content_instance_values to change it everywhere",
        },
      );
    }

    const instance = await loadContentInstanceStateWithBranchOverlay(
      tx,
      placement.contentInstanceId,
      ctx.chatBranchId,
    );
    const module = instance
      ? await loadModuleStateWithBranchOverlay(tx, instance.moduleId, ctx.chatBranchId)
      : null;
    if (!instance || instance.deletedAt !== null || !module) {
      return fail(
        "The content of this section no longer exists. Reload the preview and try again.",
      );
    }

    const values: Record<string, unknown> = { ...instance.values };
    for (const edit of input.edits) {
      const def = module.fields.find(
        (f): f is { name: string; kind?: string } =>
          typeof f === "object" && f !== null && (f as { name?: unknown }).name === edit.field,
      );
      if (!def) {
        return fail(`The module has no field "${edit.field}". Reload the preview and try again.`);
      }
      const patch = applyEdit(def.kind ?? "text", values[edit.field], edit);
      if (!patch.ok) return fail(`Cannot edit "${edit.field}": ${patch.message}.`);
      values[edit.field] = patch.value;
    }

    const written = await setContentInstanceValuesOp.handler(
      ctx,
      { id: placement.contentInstanceId, values, expectedVersion: instance.version },
      tx,
    );
    if (!written.ok) {
      const inner = written.error as { message?: string };
      return fail(inner.message ?? "saving the change failed");
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: OP,
      input,
      succeeded: true,
      entityId: placement.contentInstanceId,
      resultSummary: `fields=${input.edits.map((e) => (e.index !== undefined ? `${e.field}[${e.index}]` : e.field)).join(",")}`,
    });
    return ok({ contentInstanceId: placement.contentInstanceId, version: written.value.version });
  },
});
