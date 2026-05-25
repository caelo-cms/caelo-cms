// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.0 — AI tool: import_theme. DTCG-only this slice; the verbatim
 * format-auto-detect description from #45's follow-up comment lands
 * when the auto-detector ships in v0.11.2.
 */

import { execute } from "@caelo-cms/query-api";
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

export const importThemeTool: ToolDefinitionWithHandler<ImportThemeToolInput> = {
  name: "import_theme",
  description:
    "Import a DTCG JSON document into an EXISTING theme — replaces the target theme's tokens " +
    "wholesale. Server validates against the DTCG schema first; pre-Zod sniff rejects bodies " +
    "that aren't DTCG-shaped (no `$value` leaves anywhere). Pass the raw JSON in `body` and " +
    "the target slug in `themeSlug`. " +
    "The slug MUST already exist — minting a new theme goes through `propose_create_theme` " +
    "(gated) so this tool never creates one. " +
    "Format auto-detection across Style Dictionary / Tailwind 4 / shadcn CSS variables / " +
    "loose key-value lands in v0.11.2 — for now, send DTCG only.",
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
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.import_dtcg", input);
    if (!r.ok)
      return { ok: false, content: `themes.import_dtcg failed: ${describeError(r.error)}` };
    const v = r.value as { themeId: string; format: "dtcg" };
    return {
      ok: true,
      content: `imported ${v.format} into theme '${input.themeSlug}' (themeId ${v.themeId})`,
    };
  },
};
