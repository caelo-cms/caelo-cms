// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.0 — `list_themes` (2026-07: makeListReadTool — TOON output,
 * uniform filter/limit/offset/full). Carries the UUID because
 * propose_activate_theme requires it (issue #106 step-13 deviation).
 */

import { z } from "zod";
import { makeListReadTool } from "./_make-read-tool.js";

const listThemesInput = z.object({}).strict();

export const listThemesTool = makeListReadTool<
  Record<string, never>,
  { id: string; slug: string; displayName: string; isActive: boolean }
>({
  name: "list_themes",
  description:
    "List every theme with UUID, slug, display name, and active flag (TOON rows). " +
    "Standard list params: `filter`, `limit`/`offset`, `full: true`. " +
    "propose_activate_theme requires the UUID listed here.",
  opName: "themes.list",
  input: listThemesInput,
  label: "themes",
  rows: (value) =>
    (value as { themes: { id: string; slug: string; displayName: string; isActive: boolean }[] })
      .themes,
  columns: [
    { key: "slug", value: (t) => t.slug },
    { key: "id", value: (t) => t.id },
    { key: "displayName", value: (t) => t.displayName },
    { key: "active", value: (t) => (t.isActive ? "yes" : "") },
  ],
  emptyMessage: "No themes on this site yet.",
});
