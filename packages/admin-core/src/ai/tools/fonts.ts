// SPDX-License-Identifier: MPL-2.0
import {
  acquireFontInput,
  acquireGoogleFont,
  fontCatalog,
  googleFontFiles,
} from "@caelo-cms/font-service";
import { execute } from "@caelo-cms/query-api";
import { fontFindInput, fontRef, fontResolveInput } from "@caelo-cms/shared";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import { makeReadTool } from "./_make-read-tool.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

function compact(value: unknown): string {
  return JSON.stringify(value, (key, val) =>
    key === "license" && val && typeof val === "object"
      ? { ...val, text: "Stored with immutable font revision; view in /design/fonts" }
      : val,
  );
}
export const findFontsTool: ToolDefinitionWithHandler<z.infer<typeof fontFindInput>> = {
  name: "find_fonts",
  description:
    "Find installed immutable font faces and Google Fonts catalog suggestions. Catalog entries are not installed files; acquire_font installs a complete licensed face. Use the same pinned id/sha256 for theme and plugin consumers.",
  schema: fontFindInput,
  async handler(ctx, input, toolCtx) {
    const result = await execute(toolCtx.registry, toolCtx.adapter, ctx, "fonts.find", input);
    if (!result.ok) return { ok: false, content: describeError(result.error) };
    return {
      ok: true,
      content: compact({ installed: result.value, catalog: await fontCatalog(input.query) }),
    };
  },
};
export const inspectFontTool = makeReadTool({
  name: "inspect_font",
  description:
    "Inspect a pinned font face: family, format, weight, axes, license, embedding restrictions and provenance. Missing or mismatched revisions fail.",
  opName: "fonts.inspect",
  input: fontRef,
  format: compact,
  includeValue: false,
});
export const previewTypographyTool = makeReadTool({
  name: "preview_typography",
  description:
    "Validate a pinned font for the actual specimen text, required web/document use and supported formats. Rejects missing glyphs or forbidden embedding. Open /design/fonts for the real loaded-face preview; does not send specimen text to a remote font provider.",
  opName: "fonts.resolve",
  input: fontResolveInput,
  format: (value) => `${compact(value)}\nReal font preview: /design/fonts`,
  includeValue: false,
});
export const acquireFontTool: ToolDefinitionWithHandler<z.infer<typeof acquireFontInput>> = {
  name: "acquire_font",
  description:
    "Import a complete Google Fonts face plus its actual Open Font License into Caelo's shared immutable library. Optional filename chooses an exact variant returned by list_font_variants. Revisions persist for restores and plugin exports; this does not assign or publish the font.",
  schema: acquireFontInput,
  async handler(ctx, input, toolCtx) {
    try {
      const result = await execute(
        toolCtx.registry,
        toolCtx.adapter,
        ctx,
        "fonts.import",
        await acquireGoogleFont(input),
      );
      return result.ok
        ? { ok: true, content: compact(result.value) }
        : { ok: false, content: describeError(result.error) };
    } catch (e) {
      return { ok: false, content: e instanceof Error ? e.message : "Font acquisition failed" };
    }
  },
};
const variantsInput = z.object({ family: acquireFontInput.shape.family }).strict();
export const listFontVariantsTool: ToolDefinitionWithHandler<z.infer<typeof variantsInput>> = {
  name: "list_font_variants",
  description:
    "List complete Google Fonts file variants available for acquire_font (including italic and variable fonts).",
  schema: variantsInput,
  async handler(_ctx, input) {
    try {
      return { ok: true, content: JSON.stringify(await googleFontFiles(input.family)) };
    } catch (e) {
      return { ok: false, content: e instanceof Error ? e.message : "Font variants unavailable" };
    }
  },
};
