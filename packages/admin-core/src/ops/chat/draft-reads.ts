// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1260 — `chat.observe_draft_reads`: record that the caller's draft
 * chat has read entities' current draft state.
 *
 * The AI's read tools (`read_content`, `get_content_instance`,
 * `inspect_page_render`, `get_theme`, `get_list`, `list_list_types`,
 * `list_page_types`) call it after a successful read through the dispatcher
 * (`ToolDefinitionWithHandler.draftReads`). That read is what a draft
 * conflict asks for ("read it again with …", `locks.ts`), and only a read
 * recorded here clears the conflict: the observation the refused write
 * itself records is rolled back when a bulk write aborts.
 *
 * Recording sits at the tool, not inside the get ops, on purpose: write
 * tools and the chat runner read the same ops internally (a design guard
 * reading `modules.get` before `update_modules_many`, the current-page
 * context reading `pages.get_with_modules` every turn). Counting those as
 * "the AI has seen it" would let a write built on stale content overwrite
 * another chat's change without a conflict.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { z } from "zod";
import { DRAFT_READ_KINDS, observeDraftReads } from "../../locks.js";

/** Most entities one call records — a list read's page of rows. */
export const DRAFT_READS_MAX = 500;

export const observeDraftReadsOp = defineOperation({
  name: "chat.observe_draft_reads",
  readScope: "request",
  // Default scope (CLAUDE.md §11). It only marks the caller's OWN chat as
  // having seen entities; a non-draft or unidentified caller records nothing.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** When the read began (ISO); a change committed after it stays unseen. */
      seenAt: z.string().datetime({ offset: true }),
      reads: z
        .array(
          z
            .object({
              kind: z.enum(DRAFT_READ_KINDS),
              ids: z.array(z.string().uuid()).min(1).max(DRAFT_READS_MAX),
            })
            .strict(),
        )
        .min(1)
        .max(DRAFT_READ_KINDS.length),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    for (const read of input.reads) {
      await observeDraftReads(tx, ctx, read.kind, read.ids, input.seenAt);
    }
    return ok({});
  },
});
