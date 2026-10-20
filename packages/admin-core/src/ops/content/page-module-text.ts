// SPDX-License-Identifier: MPL-2.0

/**
 * #917 — `page_module_content.set_text`: change ONE piece of text on a
 * placement, the way Live Edit's in-place editing does. The operator
 * edits what they see; this op patches exactly that field (or list
 * item) and leaves every other value of the placement as it is.
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

const OP = "page_module_content.set_text";

/**
 * Text fields store HTML-ready strings (the template engine substitutes
 * them unescaped), so the operator's plain text is escaped once here:
 * "Fish & chips" must not turn into an entity reference, "<3" not into a
 * tag.
 */
export function escapeFieldText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type Patch = { ok: true; value: unknown } | { ok: false; message: string };

/** The field's new value with `text` set at `index` (lists), or a reason it cannot be. */
function patchField(
  kind: string,
  current: unknown,
  index: number | undefined,
  text: string,
): Patch {
  if (kind === "text") {
    if (index !== undefined) return { ok: false, message: "a text field takes no index" };
    return { ok: true, value: text };
  }
  if (kind !== "text-list" && kind !== "link-list") {
    return { ok: false, message: `a ${kind} field cannot be edited as plain text` };
  }
  if (index === undefined) return { ok: false, message: `a ${kind} field needs the item index` };
  if (!Array.isArray(current) || index >= current.length) {
    return {
      ok: false,
      message: `item ${index} does not exist (the list has ${Array.isArray(current) ? current.length : 0})`,
    };
  }
  const next = [...current];
  if (kind === "text-list") {
    next[index] = text;
  } else {
    const item = current[index];
    if (typeof item !== "object" || item === null) {
      return { ok: false, message: `item ${index} is not a link` };
    }
    next[index] = { ...item, label: text };
  }
  return { ok: true, value: next };
}

export const setPageModuleTextOp = defineOperation({
  name: OP,
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      pageId: z.string().uuid(),
      blockName: z.string().min(1),
      position: z.number().int().nonnegative(),
      /** Field name as the module declares it. */
      field: z.string().min(1).max(200),
      /** Item index for a `text-list` item or a `link-list` label. */
      index: z.number().int().nonnegative().optional(),
      /** Plain text as the operator typed it; escaped before storing. */
      text: z.string().max(10_000),
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
      return err({
        kind: "HandlerError",
        operation: OP,
        message: `This section is no longer on the page (no placement at ${input.blockName} #${input.position}). Reload the preview and try again.`,
      });
    }
    if (placement.syncMode === "synced") {
      return err({
        kind: "HandlerError",
        operation: OP,
        message:
          "This text is shared with other pages, so it is not edited in place. Ask the AI to change it everywhere or only on this page.",
        nextAction: {
          tool: "fork_placement_content",
          args: { pageId: input.pageId, blockName: input.blockName, position: input.position },
          reason:
            "detach this placement so the edit stays on this page, or call set_content_instance_values to change it everywhere",
        },
      });
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
      return err({
        kind: "HandlerError",
        operation: OP,
        message: "The content of this section no longer exists. Reload the preview and try again.",
      });
    }
    const def = module.fields.find(
      (f): f is { name: string; kind?: string } =>
        typeof f === "object" && f !== null && (f as { name?: unknown }).name === input.field,
    );
    if (!def) {
      return err({
        kind: "HandlerError",
        operation: OP,
        message: `The module has no field "${input.field}". Reload the preview and try again.`,
      });
    }
    const patch = patchField(
      def.kind ?? "text",
      instance.values[input.field],
      input.index,
      escapeFieldText(input.text),
    );
    if (!patch.ok) {
      return err({
        kind: "HandlerError",
        operation: OP,
        message: `Cannot edit "${input.field}": ${patch.message}.`,
      });
    }

    const written = await setContentInstanceValuesOp.handler(
      ctx,
      {
        id: placement.contentInstanceId,
        values: { ...instance.values, [input.field]: patch.value },
        expectedVersion: instance.version,
      },
      tx,
    );
    if (!written.ok) {
      const inner = written.error as { message?: string };
      return err({
        kind: "HandlerError",
        operation: OP,
        message: inner.message ?? "saving the text failed",
      });
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: OP,
      input,
      succeeded: true,
      entityId: placement.contentInstanceId,
      resultSummary: `field=${input.field}${input.index !== undefined ? `[${input.index}]` : ""}`,
    });
    return ok({ contentInstanceId: placement.contentInstanceId, version: written.value.version });
  },
});
