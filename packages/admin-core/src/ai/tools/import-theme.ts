// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.1 (issue #76) — AI tool: import_theme.
 *
 * Replaces an existing theme's tokens by accepting any of the major
 * token formats the ecosystem uses. The TS-land `autoDetectAndImport`
 * walks the importer chain (DTCG → Style Dictionary → Tailwind 4 →
 * shadcn → loose) and the op `themes.import` accepts the pre-parsed
 * `ThemeDocument`. The detected format string flows back to the AI so
 * subsequent turns don't re-detect.
 *
 * Verbatim description text from issue #45's follow-up comment:
 *   "Import a theme from JSON or CSS. Server auto-detects DTCG /
 *    Style Dictionary / Tailwind 4 / shadcn-CSS-vars / loose key-value
 *    formats. Pass the raw text in `body`. Returns the detected format
 *    + the slug of the imported theme."
 *
 * Pinned in tests as a regression guard — the AI-side prompt depends
 * on this exact wording.
 */

import { execute } from "@caelo-cms/query-api";
import {
  type AutoDetectResult,
  autoDetectAndImport,
  NoImporterMatched,
  TailwindImportError,
} from "@caelo-cms/shared";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const importThemeToolInput = z
  .object({
    themeSlug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    body: z.string().min(1).max(1_000_000),
  })
  .strict();
type ImportThemeToolInput = z.infer<typeof importThemeToolInput>;

/**
 * v0.11.1 — verbatim description from issue #45's follow-up comment
 * ("Tool descriptions (verbatim updates)" section). Pinned by the
 * `import-theme.test.ts` regression guard.
 */
export const IMPORT_THEME_DESCRIPTION =
  "Import a theme from JSON or CSS. Server auto-detects DTCG / Style Dictionary / " +
  "Tailwind 4 / shadcn-CSS-vars / loose key-value formats. Pass the raw text in `body`. " +
  "Returns the detected format + the slug of the imported theme.";

export const importThemeTool: ToolDefinitionWithHandler<ImportThemeToolInput> = {
  name: "import_theme",
  description: IMPORT_THEME_DESCRIPTION,
  schema: importThemeToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["themeSlug", "body"],
    properties: {
      themeSlug: { type: "string", minLength: 1, maxLength: 120 },
      body: { type: "string", minLength: 1, maxLength: 1_000_000 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    // 1. Auto-detect the format in TS-land so the op surface stays
    //    parser-free (single responsibility: write pre-parsed tokens).
    let detected: AutoDetectResult;
    try {
      detected = autoDetectAndImport(input.body);
    } catch (e) {
      if (e instanceof NoImporterMatched) {
        return { ok: false, content: e.message };
      }
      if (e instanceof TailwindImportError) {
        return { ok: false, content: e.message };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, content: `theme import failed: ${msg}` };
    }

    // 2. Submit pre-parsed tokens to the (renamed in v0.11.1) op.
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.import", {
      themeSlug: input.themeSlug,
      tokens: detected.tokens,
    });
    if (!r.ok) {
      return { ok: false, content: `themes.import failed: ${describeError(r.error)}` };
    }
    const v = r.value as { themeId: string };
    return {
      ok: true,
      content: `imported ${detected.format} into theme '${input.themeSlug}' (themeId ${v.themeId}, detectedFormat=${detected.format})`,
    };
  },
};
