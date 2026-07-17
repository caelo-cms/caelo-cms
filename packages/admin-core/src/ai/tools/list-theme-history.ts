// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.2 — `list_theme_history` (2026-07: makeListReadTool — TOON
 * output). The op caps at 100 entries; `full: true` requests that max.
 */

import type { ExecutionContext } from "@caelo-cms/shared";
import { z } from "zod";
import { makeListReadTool } from "./_make-read-tool.js";
import type { ToolContext } from "./dispatch.js";

const listThemeHistoryInput = z
  .object({
    themeSlug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional(),
  })
  .strict();

interface HistoryRow {
  createdAt: string;
  opKind: string;
  actorKind: string;
  actorName: string;
  chatBranchId: string | null;
  originAtTime: string | null;
  summary: string;
}

export const listThemeHistoryTool = makeListReadTool<
  z.infer<typeof listThemeHistoryInput>,
  HistoryRow
>({
  name: "list_theme_history",
  description:
    "List a theme's edit history (who changed what, when — TOON rows), newest first. Defaults to the ACTIVE theme; pass `themeSlug` for another. " +
    "Standard list params: `filter`, `limit`/`offset`, `full: true` (op max 100 entries).",
  opName: "themes.list_history",
  input: listThemeHistoryInput,
  buildOpInput: (
    input: { themeSlug?: string; limit?: number; full?: boolean },
    _ctx: ExecutionContext,
    _toolCtx: ToolContext,
  ) => ({
    ...(input.themeSlug !== undefined ? { themeSlug: input.themeSlug } : {}),
    // The op caps at 100; fetch generously so client-side filter/offset
    // operate on the real tail, then let the factory paginate.
    limit: input.full ? 100 : Math.min(input.limit ?? 20, 100),
  }),
  label: "theme_history",
  rows: (value) => (value as { entries: HistoryRow[] }).entries,
  columns: [
    { key: "at", value: (e) => e.createdAt },
    { key: "actor", value: (e) => `${e.actorKind}(${e.actorName})` },
    { key: "op", value: (e) => e.opKind },
    { key: "origin", value: (e) => e.originAtTime ?? "" },
    { key: "branched", value: (e) => (e.chatBranchId ? "yes" : "") },
    { key: "summary", value: (e) => e.summary },
  ],
  emptyMessage: "No history yet — this theme hasn't been edited.",
});
