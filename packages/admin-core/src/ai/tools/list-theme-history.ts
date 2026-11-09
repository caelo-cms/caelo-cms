// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.2 — `list_theme_history` (2026-07: makeListReadTool — TOON
 * output). #1538 — the op pages by `offset`, so older edits stay reachable.
 */

import { z } from "zod";
import { makeListReadTool } from "./_list-read-tool.js";

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
    "List a theme's edit history (who changed what, when; newest first). Omit `themeSlug` for the ACTIVE theme.",
  opName: "themes.list_history",
  input: listThemeHistoryInput,
  // The op takes at most 100 rows; one more than the page says whether more exist.
  paging: { kind: "offset", maxLimit: 50 },
  defaultLimit: 20,
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
