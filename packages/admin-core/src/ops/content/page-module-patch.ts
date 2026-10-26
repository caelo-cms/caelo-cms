// SPDX-License-Identifier: MPL-2.0

/**
 * #917 — `page_module_content.patch_fields`: change individual values of
 * ONE placement, the way Live Edit's in-place editing does. The operator
 * edits what they see; this op patches exactly those fields (or values
 * of local list entries) and leaves every other value of the placement
 * as it is.
 *
 * Bulk-first (CLAUDE.md §11): `edits` carries one entry per changed value
 * so a link's label + target or an image + its alt text land in one call
 * and one snapshot. A single text edit is the one-element case.
 *
 * #918 — a synced (shared) placement needs `scope`: "everywhere" writes
 * the shared instance (every page that shows it changes), "here" forks
 * the placement first (`placement.fork_content`) and writes the copy.
 *
 * The placement is resolved through the caller's branch-overlaid layout,
 * the same view the preview renders (so the text the operator clicked is
 * the text that changes). Read + patch + write run in one transaction
 * through `content_instances.set_values` (lock, snapshot, version check),
 * so a concurrent edit of another field cannot be overwritten by a stale
 * read, and chat Undo reverts it.
 */

import { defineOperation } from "@caelo-cms/query-api";
import {
  applyListItemPatches,
  err,
  findListItem,
  type ListItem,
  ListPatchError,
  listNameSchema,
  ok,
} from "@caelo-cms/shared";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import {
  loadContentInstanceStateWithBranchOverlay,
  loadModuleStateWithBranchOverlay,
  loadPageLayoutStateWithBranchOverlay,
} from "../../snapshots/index.js";
import { forkPlacementContentOp, setContentInstanceValuesOp } from "./content-instances.js";

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

/**
 * A link target or image address as the operator typed it; refused when
 * it could break out of the attribute it lands in. Internal paths become
 * page / media references in `content_instances.set_values` (#724), which
 * also refuses a link to no page.
 */
const TARGET = /^(\/|#|https?:\/\/|mailto:|tel:|caelo:)\S*$/;
const IMAGE = /^(\/|https?:\/\/|caelo:media\/)\S*$/;
const ATTRIBUTE_BREAKOUT = /["'<>\s]/;

const editSchema = z
  .object({
    /** Field name as the module declares it. */
    field: z.string().min(1).max(200),
    /** Entry id in a local `list` field (epic #1107); entry ids never change. */
    item: z.string().uuid().optional(),
    /** The entry's field to change (`label`, `text`, `link`, …). */
    key: listNameSchema.optional(),
    /** `href`: change a link field's target instead of a text value. */
    part: z.literal("href").optional(),
    /**
     * The new value as the operator typed it: plain text for text, a URL /
     * path for `url`, `image` and link targets.
     */
    text: z.string().max(10_000),
  })
  .strict();
type Edit = z.infer<typeof editSchema>;

type Patch = { ok: true; value: unknown } | { ok: false; message: string };

function address(value: string, pattern: RegExp, what: string): Patch {
  const v = value.trim();
  if (!pattern.test(v) || ATTRIBUTE_BREAKOUT.test(v)) {
    return {
      ok: false,
      message: `"${value}" is not a valid ${what} (use a path like /pricing or a full https:// address)`,
    };
  }
  return { ok: true, value: v };
}

/** The field's new value with the edit applied, or a reason it cannot be. */
function applyEdit(
  def: { readonly kind?: string; readonly bind?: string },
  current: unknown,
  edit: Edit,
): Patch {
  const kind = def.kind ?? "text";
  if (kind === "text" || kind === "url" || kind === "image") {
    if (edit.item !== undefined || edit.key !== undefined || edit.part !== undefined) {
      return { ok: false, message: `a ${kind} field takes no item, key or part` };
    }
    if (kind === "url") return address(edit.text, TARGET, "link target");
    if (kind === "image") return address(edit.text, IMAGE, "image address");
    return { ok: true, value: escapeFieldText(edit.text) };
  }
  if (kind !== "list") {
    return { ok: false, message: `a ${kind} field cannot be edited here` };
  }
  if ((def.bind ?? "local") !== "local") {
    return {
      ok: false,
      message:
        "its entries live in a shared list or a source, not in this section — edit the list instead",
    };
  }
  if (edit.item === undefined || edit.key === undefined) {
    return { ok: false, message: "a list field needs the entry (item) and its field (key)" };
  }
  const items = (Array.isArray(current) ? current : []) as ListItem[];
  const entry = findListItem(items, edit.item);
  if (!entry) return { ok: false, message: `entry ${edit.item} does not exist in the list` };
  let value: unknown;
  if (edit.part === "href") {
    const link = entry.values[edit.key];
    if (typeof link !== "object" || link === null) {
      return { ok: false, message: `"${edit.key}" of that entry is not a link` };
    }
    const target = address(edit.text, TARGET, "link target");
    if (!target.ok) return target;
    value = { ...(link as Record<string, unknown>), href: target.value };
  } else {
    value = escapeFieldText(edit.text);
  }
  try {
    return {
      ok: true,
      value: applyListItemPatches(items, [
        { op: "update", itemId: edit.item, values: { [edit.key]: value } },
      ]),
    };
  } catch (e) {
    if (e instanceof ListPatchError) return { ok: false, message: e.message };
    throw e;
  }
}

function fail(
  message: string,
  nextAction?: { tool: string; args: Record<string, unknown>; reason: string },
) {
  return err({ kind: "HandlerError" as const, operation: OP, message, nextAction });
}

/** Input of `page_module_content.patch_fields`; the AI tool validates with it too. */
export const patchPageModuleFieldsInput = z
  .object({
    pageId: z.string().uuid(),
    blockName: z.string().min(1),
    position: z.number().int().nonnegative(),
    edits: z.array(editSchema).min(1).max(20),
    /**
     * #918 — for a synced (shared) placement: change the shared content on
     * every page that shows it, or detach this placement first and change it
     * only here. Required for a synced placement, ignored otherwise.
     */
    scope: z.enum(["everywhere", "here"]).optional(),
  })
  .strict();

export const patchPageModuleFieldsOp = defineOperation({
  name: OP,
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: patchPageModuleFieldsInput,
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
    let targetId = placement.contentInstanceId;
    if (placement.syncMode === "synced") {
      if (input.scope === undefined) {
        return fail(
          'This content is shared with other pages. Say whether to change it everywhere (scope "everywhere") or only on this page (scope "here").',
        );
      }
      if (input.scope === "here") {
        const forked = await forkPlacementContentOp.handler(
          ctx,
          { pageId: input.pageId, blockName: input.blockName, position: input.position },
          tx,
        );
        if (!forked.ok) {
          const inner = forked.error as { message?: string };
          return fail(inner.message ?? "detaching this section from the shared content failed");
        }
        targetId = forked.value.contentInstanceId;
      }
    }

    const instance = await loadContentInstanceStateWithBranchOverlay(
      tx,
      targetId,
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
        (f): f is { name: string; kind?: string; bind?: string } =>
          typeof f === "object" && f !== null && (f as { name?: unknown }).name === edit.field,
      );
      if (!def) {
        return fail(`The module has no field "${edit.field}". Reload the preview and try again.`);
      }
      const patch = applyEdit(def, values[edit.field], edit);
      if (!patch.ok) return fail(`Cannot edit "${edit.field}": ${patch.message}.`);
      values[edit.field] = patch.value;
    }

    const written = await setContentInstanceValuesOp.handler(
      ctx,
      { id: targetId, values, expectedVersion: instance.version },
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
      entityId: targetId,
      resultSummary: `scope=${placement.syncMode === "synced" ? input.scope : "own"} fields=${input.edits.map((e) => (e.item !== undefined ? `${e.field}[${e.item}].${e.key}` : e.field)).join(",")}`,
    });
    return ok({ contentInstanceId: targetId, version: written.value.version });
  },
});
