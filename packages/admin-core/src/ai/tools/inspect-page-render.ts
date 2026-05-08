// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.69 — `inspect_page_render` AI tool.
 *
 * Returns the fully composed HTML of a page + every CSS layer
 * separately (layout / template / theme / modules). The AI uses this
 * BEFORE proposing CSS or layout fixes, so it can see the actual
 * cascade the visitor's browser would apply instead of guessing.
 *
 * Closes the gap that surfaced in today's homepage build: operator
 * asked the AI to remove white padding around header/footer; the AI
 * couldn't see the layout / template wrapper CSS, guessed twice
 * (body reset, then `!important`), neither worked, ended with
 * "could you do me a favour, open DevTools and tell me what's
 * showing the padding?". With this tool the AI can find the
 * culprit in a single read-only call.
 *
 * No new infrastructure: wraps the existing `pages.render_preview`
 * op (which already returns the composed HTML) and pulls
 * layout/template/theme/modules from their respective ops so the AI
 * sees each CSS layer in isolation. ~50-200KB JSON payload per call;
 * fine for a single tool call but the description tells the AI not
 * to loop on the same page within one turn.
 *
 * Phase 2 (v0.3.0+): once the Vercel AI SDK migration lands and the
 * provider abstraction supports multimodal, a sibling
 * `screenshot_page` tool ships for visual feedback (operator's own
 * browser captures via html2canvas). HTML-inspection covers the
 * 80% CSS-debug case until then.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const inspectInput = z
  .object({
    pageId: z.string().uuid(),
    chatBranchId: z.string().uuid().optional(),
  })
  .strict();

export type InspectPageRenderInput = z.infer<typeof inspectInput>;

export const inspectPageRenderTool: ToolDefinitionWithHandler<InspectPageRenderInput> = {
  name: "inspect_page_render",
  description:
    "Render the page and return the FULL composed HTML + every CSS layer separately (layout / template / theme / each module's CSS). " +
    "USE THIS BEFORE proposing CSS or layout fixes — it's the only way to see the actual cascade the visitor's browser would apply. " +
    "When the operator reports a visual issue ('white padding', 'header is too tall', 'colors are wrong'), call this FIRST so you can find the precise rule causing it instead of guessing. " +
    "Pass `chatBranchId` to inspect the chat-branch preview (with pending edits) vs the published version — usually you want the chat branch since you're debugging your own staged edits. " +
    "Returns ~50-200KB of structured JSON. Fine for one tool call per debugging task; don't loop on the same page within one turn.",
  schema: inspectInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      chatBranchId: {
        type: "string",
        format: "uuid",
        description:
          "Optional. When set, the rendered preview reflects the chat-branch's staged edits. Usually the right choice when you're debugging an issue the operator can see in /edit.",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    // 1. Composed HTML — the final string the visitor's browser would
    //    parse. Same path the /edit preview iframe uses.
    const renderR = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.render_preview", {
      pageId: input.pageId,
      ...(input.chatBranchId ? { chatBranchId: input.chatBranchId } : {}),
    });
    if (!renderR.ok) {
      return {
        ok: false,
        content: `render_preview failed: ${describeError(renderR.error)}`,
      };
    }
    const rendered = renderR.value as {
      html: string;
      pageSlug: string;
      pageLocale: string;
      replacedSlots: string[];
      missingSlots: string[];
    };

    // 2. Per-layer view: page → template → layout, plus modules. We
    //    use pages.get_with_modules (which already groups modules by
    //    block + reports template_blocks per the v0.2.65 fix), then
    //    fan out to template + layout + theme.
    const pageR = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.get_with_modules", {
      pageId: input.pageId,
    });
    if (!pageR.ok) {
      return {
        ok: false,
        content: `pages.get_with_modules failed: ${describeError(pageR.error)}`,
      };
    }
    const page = (
      pageR.value as {
        page: {
          id: string;
          slug: string;
          locale: string;
          title: string;
          templateId: string;
          blocks: {
            blockName: string;
            modules: {
              moduleId: string;
              slug: string;
              displayName: string;
              html: string;
              css: string;
              js: string;
            }[];
          }[];
        };
      }
    ).page;

    // 3. Template detail (slug, html, css). We don't have a single op
    //    that returns html+css; templates.list returns metadata, so
    //    we read directly. Same for layouts — they're metadata-only
    //    in templates.list. Use raw select via a helper op.
    //
    //    Pragmatic shortcut: re-use pages.render_preview's first
    //    SELECT (which already reads template.html + layout.html);
    //    here we issue a small targeted read since the render_preview
    //    output projects the composed HTML, not the layered ones.
    const templateR = await execute(toolCtx.registry, toolCtx.adapter, ctx, "templates.list", {});
    const template = templateR.ok
      ? ((
          templateR.value as {
            templates: {
              id: string;
              slug: string;
              displayName: string;
              html: string;
              css: string;
              layoutId: string;
            }[];
          }
        ).templates.find((t) => t.id === page.templateId) ?? null)
      : null;

    let layout: {
      id: string;
      slug: string;
      displayName: string;
      html: string;
      css: string;
    } | null = null;
    if (template) {
      const layoutR = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layouts.list", {});
      if (layoutR.ok) {
        const layouts = (
          layoutR.value as {
            layouts: typeof layout extends null ? never[] : NonNullable<typeof layout>[];
          }
        ).layouts;
        layout = layouts.find((l) => l.id === template.layoutId) ?? null;
      }
    }

    // 4. Theme tokens. Caelo's theme is a structured set under
    //    kind="theme", slug="default" — rendered as :root CSS
    //    variables in the composed output.
    let themeTokens: Record<string, string> = {};
    const themeR = await execute(toolCtx.registry, toolCtx.adapter, ctx, "structured_sets.get", {
      kind: "theme",
      slug: "default",
    });
    if (themeR.ok) {
      const themeSet = (
        themeR.value as { set: { items: { name: string; value: string }[] } | null }
      ).set;
      if (themeSet?.items) {
        themeTokens = Object.fromEntries(themeSet.items.map((i) => [i.name, i.value]));
      }
    }

    // 5. Build the structured response. The AI reads each layer
    //    separately to apply the cascade in its head: layout (ground)
    //    → template (override) → modules → theme (CSS-var injection).
    const result = {
      page: {
        id: page.id,
        slug: page.slug,
        locale: page.locale,
        title: page.title,
      },
      composedHtml: rendered.html,
      composedHtmlBytes: rendered.html.length,
      layout: layout
        ? {
            id: layout.id,
            slug: layout.slug,
            displayName: layout.displayName,
            html: layout.html,
            css: layout.css,
          }
        : null,
      template: template
        ? {
            id: template.id,
            slug: template.slug,
            displayName: template.displayName,
            html: template.html,
            css: template.css,
          }
        : null,
      theme: { tokens: themeTokens, tokenCount: Object.keys(themeTokens).length },
      modulesByBlock: page.blocks.map((b) => ({
        blockName: b.blockName,
        modules: b.modules.map((m) => ({
          slug: m.slug,
          displayName: m.displayName,
          html: m.html,
          css: m.css,
          // js excluded from the inspect surface — visual debug
          // doesn't typically need behaviour scripts and including
          // them blows up the JSON size.
        })),
      })),
      slots: {
        replaced: rendered.replacedSlots,
        missing: rendered.missingSlots,
      },
    };

    return {
      ok: true,
      content: JSON.stringify(result, null, 2),
    };
  },
};
