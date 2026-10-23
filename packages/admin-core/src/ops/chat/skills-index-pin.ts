// SPDX-License-Identifier: MPL-2.0

/**
 * `chat.pin_skills_index` — fix, once per chat, which plugin skills its
 * `# Skills` index left out (issue #1008, migration 0347).
 *
 * A plugin's skills are offered only on a server process that runs the
 * plugin. The index is part of the cached system prefix and is never
 * rewritten mid-chat (CLAUDE.md §2), so the set it left out must not be
 * re-derived from the current state each turn: a plugin that fails and
 * recovers mid-chat would otherwise edit the index twice. The chat-runner
 * calls this every turn with what it would leave out NOW; the first call
 * stores that, every later one returns the stored set unchanged. Later
 * availability changes reach the chat as history notices.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { jsonbParam } from "../../sql-helpers.js";

const slugList = z.array(z.string().min(1).max(120)).max(500);

export const pinSkillsIndexOp = defineOperation({
  name: "chat.pin_skills_index",
  // Open to every actor kind (CLAUDE.md §11): the chat-runner calls it as
  // the chat's operator, and writing it twice changes nothing.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid(),
      /** The plugin skills the index would leave out if it were built now. */
      unavailableSkillSlugs: slugList,
    })
    .strict(),
  output: z.object({
    /** The set fixed when the chat's index was first built. */
    unavailableSkillSlugs: slugList,
  }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE chat_sessions
      SET skills_index_unavailable = coalesce(
        skills_index_unavailable, ${jsonbParam([...input.unavailableSkillSlugs].sort())})
      WHERE id = ${input.chatSessionId}::uuid AND created_by = ${ctx.actorId}::uuid
      RETURNING skills_index_unavailable
    `)) as unknown as { skills_index_unavailable: unknown }[];
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "chat.pin_skills_index",
        message: `Chat ${input.chatSessionId} is not one of your chats — pass the chat being run.`,
      });
    }
    const stored =
      typeof row.skills_index_unavailable === "string"
        ? JSON.parse(row.skills_index_unavailable)
        : row.skills_index_unavailable;
    return ok({ unavailableSkillSlugs: slugList.parse(stored) });
  },
});
