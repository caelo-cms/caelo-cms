// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.4 (issue #76 follow-up) — AI tool: list_theme_history.
 *
 * Surfaces theme_snapshots as a readable changelog. The AI uses it to
 * answer "how has this theme evolved?" — e.g. before proposing a token
 * rewrite, scan recent edits to see whether an operator already made
 * the change a previous turn proposed.
 *
 * Returns one row per write (token edit, asset bind, meta edit,
 * activation flip, import). Each row carries the actor (who),
 * timestamp (when), op_kind (what), the description-at-that-time
 * (context), and the snapshot id (so the AI can correlate against
 * chat_branch_id if it wants to know which conversation made the
 * change).
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const listThemeHistoryToolInput = z
  .object({
    themeSlug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();
type ListThemeHistoryToolInput = z.infer<typeof listThemeHistoryToolInput>;

interface HistoryEntry {
  snapshotId: string;
  createdAt: string;
  opKind: string;
  actorKind: "human" | "ai" | "system" | "plugin";
  actorName: string;
  chatBranchId: string | null;
  descriptionAtTime: string | null;
  displayNameAtTime: string;
  originAtTime: "seed" | "ai" | "operator" | null;
  summary: string;
}

export const listThemeHistoryTool: ToolDefinitionWithHandler<ListThemeHistoryToolInput> = {
  name: "list_theme_history",
  description:
    "List recent edits to a theme — token changes, asset bindings, meta updates, activation " +
    "flips. Each entry has who (actorKind + actorName), when (createdAt), what (opKind + " +
    "summary), and the description-at-that-time so you can see how design intent has shifted. " +
    "Use BEFORE proposing a rewrite — if the operator already adjusted the palette last " +
    "session, your suggestion may already be done. Defaults to the active theme.",
  schema: listThemeHistoryToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      themeSlug: { type: "string", minLength: 1, maxLength: 120 },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.list_history", input);
    if (!r.ok) {
      return { ok: false, content: `themes.list_history failed: ${describeError(r.error)}` };
    }
    const { entries } = r.value as { entries: HistoryEntry[]; themeId: string };
    if (entries.length === 0) {
      return { ok: true, content: "No history yet — this theme hasn't been edited." };
    }
    const lines = entries.map((e) => {
      const branch = e.chatBranchId ? " [branched]" : "";
      const origin = e.originAtTime ? ` origin=${e.originAtTime}` : "";
      return `- ${e.createdAt} · ${e.actorKind}(${e.actorName}) · ${e.opKind}${origin}${branch} — ${e.summary}`;
    });
    return { ok: true, content: lines.join("\n") };
  },
};
