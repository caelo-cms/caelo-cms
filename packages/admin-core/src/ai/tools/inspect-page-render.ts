// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.69 — `inspect_page_render` AI tool.
 *
 * Returns a SLIM SUMMARY by default — the module list (moduleId, slug,
 * byte sizes), the layout/template/theme sizes, and slot status. The full
 * composed HTML and each CSS layer (layout / template / theme / one module)
 * are pulled ON DEMAND via `target` / `search`, so the ~50-200KB dump is
 * opt-in. The AI reaches for `screenshot_page` first for the visual
 * impression, and drills into a layer here only when it needs the actual
 * rule behind a CSS/layout issue instead of guessing.
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
 * sees each CSS layer in isolation. The slim default keeps the payload
 * small; a `target` pulls only the one part's bodies.
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
    /**
     * What to return. Omit for a SLIM SUMMARY (structure + byte sizes, no
     * bodies). Pass `"composed"` | `"layout"` | `"template"` | `"theme"`, or a
     * `moduleId` from the summary, to get that ONE part's full HTML+CSS.
     */
    target: z.string().max(200).optional(),
    /**
     * Substring to grep in the composed HTML — returns only the matching
     * slices (± context) instead of the whole document. Implies the composed
     * HTML; combine with `target:"composed"` or use alone.
     */
    search: z.string().max(200).optional(),
  })
  .strict();

export type InspectPageRenderInput = z.infer<typeof inspectInput>;

export const inspectPageRenderTool: ToolDefinitionWithHandler<InspectPageRenderInput> = {
  name: "inspect_page_render",
  description:
    "Inspect a rendered page's HTML/CSS cascade. By DEFAULT returns a SLIM SUMMARY — the module list (moduleId, slug, kind, byte sizes), the layout/template/theme sizes, and slot status — NOT the full markup. " +
    "For the VISUAL impression prefer `screenshot_page` (usually more telling than raw HTML). Reach for THIS when you need the actual rule behind a layout/CSS issue the screenshot can't explain. " +
    'Then drill in with `target`: `"composed"` (final HTML the browser parses) | `"layout"` | `"template"` | `"theme"` (that layer\'s html+css / tokens) | a `moduleId` from the summary (that module\'s html+css). Pass `search` to grep the composed HTML for just the slices you need — cheaper than pulling the whole document. ' +
    "By default this renders THIS chat's branch preview (your pending edits included). Pass `chatBranchId` only to inspect a DIFFERENT branch, or omit-and-run outside a chat to see the published version.",
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
          "Optional override. Defaults to the current chat's branch, so you normally omit it. Set it only to inspect another branch's staged edits.",
      },
      target: {
        type: "string",
        description:
          'Omit for the slim summary. Else "composed" | "layout" | "template" | "theme", or a moduleId from the summary, to get that one part\'s full HTML+CSS.',
      },
      search: {
        type: "string",
        description:
          "Substring to grep in the composed HTML — returns only the matching slices with context instead of the whole document.",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    // Run #8 R3 — default to the CURRENT chat's branch. The AI edits on
    // its chat branch (write ops carry ctx.chatBranchId), but pre-run-#8
    // this tool only used the branch when the model remembered to pass
    // `chatBranchId` explicitly — so mid-rebuild inspections showed the
    // PUBLISHED page, and the AI "fixed" things it had already fixed.
    const chatBranchId = input.chatBranchId ?? toolCtx.chatBranchId;
    // 1. Composed HTML — the final string the visitor's browser would
    //    parse. Same path the /edit preview iframe uses.
    const renderR = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.render_preview", {
      pageId: input.pageId,
      ...(chatBranchId ? { chatBranchId } : {}),
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

    interface LayoutRow {
      id: string;
      slug: string;
      displayName: string;
      html: string;
      css: string;
    }
    let layout: LayoutRow | null = null;
    if (template) {
      const layoutR = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layouts.list", {});
      if (layoutR.ok) {
        const layouts = (layoutR.value as { layouts: LayoutRow[] }).layouts;
        layout = layouts.find((l) => l.id === template.layoutId) ?? null;
      }
    }

    // 4. Theme tokens. v0.11.0 (#45) — theme moved out of structured_sets
    //    into its own `themes` table with DTCG-shaped jsonb tokens.
    //    Pre-v0.11 this read structured_sets WHERE kind='theme' AND
    //    slug='default'; that path is gone (the Zod enum rejects 'theme').
    //    Read the active theme row instead and flatten the DTCG document
    //    into a `{[canonicalPath]: string}` map for the inspector output.
    let themeTokens: Record<string, string> = {};
    const themeR = await execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.get_active", {});
    if (themeR.ok) {
      const theme = (themeR.value as { theme: { tokens: unknown } | null }).theme;
      if (theme?.tokens) {
        themeTokens = flattenThemeTokensForInspector(theme.tokens);
      }
    }

    // 5. Build the structured response. The AI reads each layer
    //    separately to apply the cascade in its head: layout (ground)
    //    → template (override) → modules → theme (CSS-var injection).
    // Flatten modules to one list (with moduleId + block) so the summary can
    // expose byte sizes and the `target:<moduleId>` path can pull one body.
    const modules = page.blocks.flatMap((b) =>
      b.modules.map((m) => ({
        moduleId: m.moduleId,
        slug: m.slug,
        displayName: m.displayName,
        blockName: b.blockName,
        html: m.html,
        css: m.css,
        js: m.js,
      })),
    );

    const target = input.target?.trim();
    const search = input.search?.trim();
    const themeTokenCount = Object.keys(themeTokens).length;

    // ── Targeted retrieval — return ONE part's full bodies, not the dump. ──
    if (target === "composed" || (search && !target)) {
      const html = search ? sliceMatches(rendered.html, search) : rendered.html;
      return okJson({
        target: "composed",
        ...(search ? { search } : {}),
        composedHtml: html,
        composedHtmlBytes: rendered.html.length,
      });
    }
    if (target === "layout") {
      return okJson({ target: "layout", layout });
    }
    if (target === "template") {
      return okJson({ target: "template", template });
    }
    if (target === "theme") {
      return okJson({
        target: "theme",
        theme: { tokens: themeTokens, tokenCount: themeTokenCount },
      });
    }
    if (target) {
      // Anything else is treated as a moduleId. Look among the page's own
      // block modules first.
      const mod = modules.find((m) => m.moduleId === target);
      if (mod) return okJson({ target: "module", module: mod });
      // Not a page-block module — but the composed render ALSO includes chrome
      // (header/footer) bound to the LAYOUT and modules on the TEMPLATE, plus
      // the AI may hold a reusable module's id. Fetch it directly so inspecting
      // a chrome/reusable module by id returns its body instead of a dead end.
      const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.get", {
        moduleId: target,
      });
      if (got.ok) {
        const m = (
          got.value as {
            module: {
              id: string;
              slug: string;
              displayName: string;
              html: string;
              css: string;
              js: string;
            };
          }
        ).module;
        return okJson({
          target: "module",
          // Loud: this id is not one of the page's block modules — it was
          // fetched by id, so it is layout/template chrome or a reusable module.
          note: "not among this page's block modules — fetched by id (layout/template chrome, or a reusable module). Use target:'layout' or target:'template' for the chrome shell.",
          module: {
            moduleId: m.id,
            slug: m.slug,
            displayName: m.displayName,
            html: m.html,
            css: m.css,
            js: m.js,
          },
        });
      }
      return {
        ok: false,
        content:
          `No module "${target}" exists (not on this page, and modules.get found no such id). ` +
          `Call inspect_page_render with NO target for this page's module list, or ` +
          `target: "composed" | "layout" | "template" | "theme".`,
      };
    }

    // ── Default — the SLIM SUMMARY (structure + sizes, no bodies). ──
    const summary = {
      page: { id: page.id, slug: page.slug, locale: page.locale, title: page.title },
      composedHtmlBytes: rendered.html.length,
      layout: layout
        ? {
            id: layout.id,
            slug: layout.slug,
            displayName: layout.displayName,
            htmlBytes: layout.html.length,
            cssBytes: layout.css.length,
          }
        : null,
      template: template
        ? {
            id: template.id,
            slug: template.slug,
            displayName: template.displayName,
            htmlBytes: template.html.length,
            cssBytes: template.css.length,
          }
        : null,
      theme: { tokenCount: themeTokenCount },
      modules: modules.map((m) => ({
        moduleId: m.moduleId,
        slug: m.slug,
        displayName: m.displayName,
        block: m.blockName,
        htmlBytes: m.html.length,
        cssBytes: m.css.length,
      })),
      slots: { replaced: rendered.replacedSlots, missing: rendered.missingSlots },
      hint:
        "SUMMARY only. For the visual impression call `screenshot_page`. For full bodies call inspect_page_render " +
        'again with target: "composed" | "layout" | "template" | "theme" | "<moduleId>", or pass `search` to grep the composed HTML.',
    };
    return okJson(summary);
  },
};

/** Serialize a value as the tool's pretty-printed JSON result. */
function okJson(value: unknown): { ok: true; content: string } {
  return { ok: true, content: JSON.stringify(value, null, 2) };
}

/**
 * Return only the slices of `html` around each occurrence of `search`
 * (case-insensitive, ± `window` chars, capped) — the grep mode that lets the
 * AI pull the one region it cares about instead of the whole composed HTML.
 */
function sliceMatches(html: string, search: string, window = 400, maxSlices = 20): string {
  const hay = html.toLowerCase();
  const needle = search.toLowerCase();
  const slices: string[] = [];
  let from = 0;
  while (slices.length < maxSlices) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) break;
    slices.push(
      html.slice(Math.max(0, idx - window), Math.min(html.length, idx + needle.length + window)),
    );
    from = idx + needle.length + window;
  }
  return slices.length > 0
    ? slices.join("\n\n…\n\n")
    : `(no occurrence of "${search}" in the composed HTML)`;
}

/**
 * v0.11.0 (#45) — flatten the active theme's DTCG tokens jsonb into a
 * `{[canonicalPath]: stringValue}` map for the inspector output. The
 * inspector's old shape was a flat `{tokenName: value}` from the legacy
 * structured-set; the closest analogue on the DTCG tree is the leaf-path
 * → string-value form (e.g. `color.primary → "#ff6600"`). Composite
 * leaves (`$value: {fontFamily, fontSize, ...}`) JSON-stringify into one
 * entry so the inspector keeps a flat shape.
 */
function flattenThemeTokensForInspector(tokens: unknown): Record<string, string> {
  if (!tokens || typeof tokens !== "object") return {};
  const out: Record<string, string> = {};
  walk(tokens as Record<string, unknown>, []);
  return out;

  function walk(node: Record<string, unknown>, prefix: readonly string[]): void {
    if ("$value" in node) {
      const v = (node as { $value: unknown }).$value;
      out[prefix.join(".")] = typeof v === "string" ? v : JSON.stringify(v);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("$")) continue;
      if (v && typeof v === "object") walk(v as Record<string, unknown>, [...prefix, k]);
    }
  }
}
