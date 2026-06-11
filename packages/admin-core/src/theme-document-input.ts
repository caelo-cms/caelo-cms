// SPDX-License-Identifier: MPL-2.0

/**
 * issue #112 — boundary schema for caller-supplied theme documents.
 *
 * `themeDocument` validates shape but not size: the recursive record
 * accepts arbitrarily large documents, and an oversized one would land
 * verbatim in `theme_pending_actions.payload`, the proposal preview,
 * and eventually `themes.tokens` — bloating every `themes.get_active`
 * read the cold-start gate and the system prompt make. This module is
 * the single place the size policy lives; both the Query API op input
 * (`themes.propose_create`) and the AI tool schema
 * (`propose_create_theme`) import it so the limits can't drift.
 */

import { themeDocument } from "@caelo-cms/shared";

/** Generous for design tokens (the seed document is ~4 KB). */
export const MAX_THEME_DOCUMENT_BYTES = 262_144;

/**
 * `themeDocument` plus the size cap. The message names the fix so the
 * AI's retry lands (CLAUDE.md §11).
 */
export const boundedThemeDocument = themeDocument.superRefine((tokens, ctx) => {
  const bytes = new TextEncoder().encode(JSON.stringify(tokens)).length;
  if (bytes > MAX_THEME_DOCUMENT_BYTES) {
    ctx.addIssue({
      code: "custom",
      message:
        `token document is ${Math.ceil(bytes / 1024)} KB (max ${MAX_THEME_DOCUMENT_BYTES / 1024} KB) — ` +
        "themes carry design tokens, not content; trim the document and re-propose.",
    });
  }
});
