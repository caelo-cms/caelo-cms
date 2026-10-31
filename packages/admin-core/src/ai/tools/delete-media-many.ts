// SPDX-License-Identifier: MPL-2.0

/**
 * `delete_media_many` — remove unused assets from the media library in one
 * call (`media.delete_many`; a single asset is a one-item array, CLAUDE.md
 * §11 bulk-first).
 *
 * The op's in-use guard is the safety contract, and this tool never passes
 * `force`: an asset still referenced by a module (live, or by this chat's
 * own unpublished module edits) comes back as BLOCKED with the referencing
 * module slugs, so the AI removes the reference first instead of stranding
 * a broken image on a page. Forced deletion of an in-use asset stays a
 * human decision in the media library UI — the soft-delete has no restore
 * op, so the blast radius of a wrong force is a broken image on every page
 * that embeds it.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError, toolError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const deleteMediaManyInput = z
  .object({
    assetIds: z.array(z.string().uuid()).min(1).max(200).describe("From `find_media`."),
  })
  .strict();

type DeleteMediaManyInput = z.infer<typeof deleteMediaManyInput>;

export const deleteMediaManyTool: ToolDefinitionWithHandler<DeleteMediaManyInput> = {
  name: "delete_media_many",
  description:
    "Delete media assets the site no longer uses (library clean-up, e.g. unused stock photos, duplicate logos). Irreversible from chat.\n" +
    "DO NOT USE FOR: keeping an asset but hiding it from page placement -> `set_media_visibility_many` (`reference`).\n" +
    "CORE RULES: assets still embedded in a module (live or in this chat's unpublished edits) are NOT deleted — returned as blocked with their modules. Remove the image there first (`update_modules_many` / `set_page_module_content_many`) or tell the operator it is in use; no force option.",
  schema: deleteMediaManyInput,
  handler: async (ctx, input, toolCtx) => {
    const unique = [...new Set(input.assetIds)];
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "media.delete_many", {
      assetIds: unique,
      force: false,
    });
    if (!r.ok) {
      return toolError(r.error, `media.delete_many failed: ${describeError(r.error)}`);
    }
    const v = r.value as {
      deleted: number;
      blocked: { assetId: string; referencingModuleSlugs: string[] }[];
    };
    const notFound = unique.length - v.deleted - v.blocked.length;
    const parts = [`Deleted ${v.deleted} of ${unique.length} asset(s).`];
    if (notFound > 0) {
      parts.push(
        `${notFound} id(s) were not found or already deleted — re-check them with find_media.`,
      );
    }
    if (v.blocked.length > 0) {
      const lines = v.blocked.map(
        (b) =>
          `  ${b.assetId}: still used by ${b.referencingModuleSlugs.length > 0 ? b.referencingModuleSlugs.join(", ") : "a module (usage counted, module not resolvable by URL)"}`,
      );
      parts.push(
        `Blocked (in use, NOT deleted):\n${lines.join("\n")}\nRemove the image from those modules first, then call delete_media_many again for these ids.`,
      );
    }
    // ok = something was actually deleted; a call that deleted nothing
    // (all blocked / unknown) is a failure the AI has to act on.
    return { ok: v.deleted > 0, content: parts.join("\n"), value: v };
  },
};
