// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.0 — AI tool: export_theme. Emits a clean DTCG JSON document
 * for a given theme. Operators / design tooling consume the output;
 * the AI rarely needs the export in-context (use `get_theme` for that)
 * but exposes the surface for round-trip workflows.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const exportThemeToolInput = z
  .object({
    themeSlug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
  })
  .strict();
type ExportThemeToolInput = z.infer<typeof exportThemeToolInput>;

export const exportThemeTool: ToolDefinitionWithHandler<ExportThemeToolInput> = {
  name: "export_theme",
  description:
    "Export a theme as a DTCG JSON document. Output round-trips through `import_theme` " +
    "byte-for-byte and is consumable by Figma Tokens Studio / Style Dictionary / any " +
    "DTCG-compatible tool. Use when the operator asks to save a theme to disk or share it " +
    "with a designer.",
  schema: exportThemeToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["themeSlug"],
    properties: { themeSlug: { type: "string", minLength: 1, maxLength: 120 } },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.export_dtcg", input);
    if (!r.ok) return { ok: false, content: `themes.export_dtcg failed: ${describeError(r.error)}` };
    const v = r.value as { themeId: string; body: string };
    return { ok: true, content: v.body };
  },
};
