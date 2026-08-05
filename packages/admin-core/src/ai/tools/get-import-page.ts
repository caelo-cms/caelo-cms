// SPDX-License-Identifier: MPL-2.0

/**
 * 2026-07 — read ONE crawled page's captured content for a build_page rebuild,
 * mirroring `inspect_external_page` but sourced from the STORED crawl (no
 * re-fetch). Returns the GIST — Markdown text + design tokens + a source-
 * screenshot handle + a `pageRef` for query_page_html/read_page_more — and
 * NEVER the raw `proposed_modules` HTML. A page's legacy page-builder markup
 * (Elementor/WPBakery/Divi div-soup) is hundreds of KB of context bloat and
 * the flow authors fresh semantic modules anyway; the same reasoning retired
 * inspect_external_page's `markup` facet in 0174. The op returns the assembled
 * HTML to this tool only, which converts it to Markdown, caches it under a
 * pageRef (shared in-process with the inspect tools), and surfaces only the
 * gist to the model.
 *
 * issue #424 — the default view is CONTENT-ONLY: the 2026-08-04 dogfood
 * measured 40-50% ballast per read (source chrome twice — desktop + mobile
 * DOM —, consent text, unreferenced `--wp--preset--*` token noise), and the
 * run's own boilerplate detection had ALREADY classified those subtrees as
 * layout/template-owned. Chrome binds once at the layout (#253/WS0), so
 * per-page rebuild reads strip it — loudly, with counters (CLAUDE.md §2) —
 * and `fullPage: true` opts back into the full stored capture. The pageRef
 * always caches the FULL HTML, so query_page_html can still pull a stripped
 * section on demand.
 */

import { execute } from "@caelo-cms/query-api";
import {
  type BoilerplateStripTarget,
  collapseDuplicateNavs,
  filterPresetThemeTokens,
  htmlToMarkdown,
  type StrippedChromeBlock,
  stripBoilerplateSubtrees,
  stripConsentSubtrees,
} from "@caelo-cms/site-importer";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import { putPageInspection, sliceMarkdown } from "./_page-inspection-cache.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

// `fullPage` is optional (not defaulted) so the inferred type keeps
// existing single-arg call sites valid; absent means content-only.
const input = z
  .object({
    importPageId: z.string().uuid(),
    fullPage: z.boolean().optional(),
  })
  .strict();
type Input = z.infer<typeof input>;

interface Gist {
  importPageId: string;
  runId: string;
  sourceUrl: string | null;
  proposedSlug: string | null;
  proposedTitle: string | null;
  html: string;
  contentHtml: string;
  chromeModuleBlocks: string[];
  themeTokens: unknown;
  sampledDesignTokens: unknown;
  screenshotObjectKey: string | null;
  boilerplateSummary: unknown;
}

/** The compact candidate shape imports.detect_boilerplate persists on
 *  import_runs.boilerplate_summary (only the fields the strip needs —
 *  unknown extra keys are ignored). */
const boilerplateSummarySchema = z.object({
  candidates: z.array(
    z.object({
      signature: z.string(),
      kind: z.enum(["content", "structure"]),
      tag: z.string(),
      suggestedPlacement: z.enum(["layout", "template", "content_instance"]),
      sampleText: z.string(),
    }),
  ),
});

/**
 * One `- …` counter line per strip family — LOUD per CLAUDE.md §2.
 * Labels are angle-bracket-free on purpose: tool output must never
 * contain markup fragments (the no-raw-HTML contract is asserted as
 * `not.toContain("<div")` in the integration test).
 */
function strippedCounterLines(args: {
  chromeModuleBlocks: readonly string[];
  chrome: readonly StrippedChromeBlock[];
  chromeNote: string | null;
  consentRemoved: number;
  duplicateNavs: number;
  droppedPresetTokens: number;
}): string[] {
  const lines: string[] = [];
  const label = (b: StrippedChromeBlock): string =>
    `${b.tag} "${b.sampleText.slice(0, 60)}${b.sampleText.length > 60 ? "…" : ""}"`;
  if (args.chromeModuleBlocks.length > 0) {
    lines.push(
      `- source chrome modules (layout-owned — bind ONCE at the layout, never per page): ${args.chromeModuleBlocks.join(", ")}`,
    );
  }
  const layout = args.chrome.filter((b) => b.placement === "layout");
  const template = args.chrome.filter((b) => b.placement === "template");
  if (layout.length > 0) {
    lines.push(
      `- repeated site-wide blocks, layout-owned per the run's boilerplate detection: ${layout.length} — ${layout.map(label).join(", ")}`,
    );
  }
  if (template.length > 0) {
    lines.push(
      `- repeated per-type blocks, template-owned per the run's boilerplate detection (bind ONCE at the template): ${template.length} — ${template.map(label).join(", ")}`,
    );
  }
  // The status lives in the LABEL (not only the note text) so this line
  // cannot be misread as a successful strip next to the lines above.
  if (args.chromeNote !== null) {
    lines.push(`- repeated in-content blocks NOT stripped: ${args.chromeNote}`);
  }
  if (args.consentRemoved > 0) {
    lines.push(`- consent noise: ${args.consentRemoved} cookie/GDPR subtree(s)`);
  }
  if (args.duplicateNavs > 0) {
    lines.push(`- duplicate nav DOM (desktop + mobile clone): ${args.duplicateNavs} collapsed`);
  }
  if (args.droppedPresetTokens > 0) {
    lines.push(
      `- design tokens: ${args.droppedPresetTokens} unreferenced --wp--preset--* entries dropped`,
    );
  }
  if (lines.length === 0) {
    lines.push("- nothing matched (no chrome / consent / duplicate-nav / preset noise here)");
  }
  return lines;
}

export const getImportPageTool: ToolDefinitionWithHandler<Input> = {
  name: "get_import_page",
  description:
    "Read ONE page's captured content from a completed crawl run as the GIST — the page text as Markdown, the crawled design tokens, and a source-screenshot handle — so you can rebuild it with build_page WITHOUT re-fetching the live site. The DEFAULT view is CONTENT-ONLY: subtrees the run's boilerplate detection classified as layout/template-owned source chrome (header/footer/nav), cookie-consent noise, duplicate mobile-nav DOM, and unreferenced --wp--preset--* token noise are stripped, each reported in a loud 'Stripped from this read' section — chrome binds ONCE at the layout/template (never rebuild it per page), so per-page reads must not repeat it. Pass fullPage: true ONLY when you genuinely need the source chrome or the raw token dump (e.g. you are rebuilding the site header/footer itself); it returns the full stored capture. It NEVER returns the source's raw page-builder HTML in either view (that div-soup is context bloat, and you author fresh semantic modules regardless). Returns: proposed slug + title; the text as Markdown (truncated with a cursor — call read_page_more for the rest); the design tokens (measured samples when captured, otherwise the page's actually-used token values — cite THESE, don't guess); and a `pageRef` so query_page_html can pull ONE specific section of the stored HTML on demand (the pageRef always carries the FULL capture, so stripped sections stay reachable). For the visual, call get_import_page_screenshot. Pass the staging import_pages id (from list_import_pages), the built page id, or a built page whose slug matches the crawl; the result always echoes the resolved staging id for the follow-up calls. Use this in the mass-import step to rebuild each crawled page; for a live URL not in a crawl use inspect_external_page instead.",
  schema: input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["importPageId"],
    properties: {
      importPageId: {
        type: "string",
        format: "uuid",
        description:
          "The staging import_pages.id, the built CMS page id, or a slug-matched built page.",
      },
      fullPage: {
        type: "boolean",
        description:
          "Default false = content-only view (source chrome, consent noise, duplicate navs and unreferenced preset tokens stripped, with loud counters). Pass true for the full stored capture — only when you genuinely need source chrome or the raw token dump.",
      },
    },
  },
  handler: async (ctx, toolInput, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "imports.get_page_gist", {
      importPageId: toolInput.importPageId,
    });
    if (!r.ok) {
      return { ok: false, content: `get_import_page failed: ${describeError(r.error)}` };
    }
    const g = r.value as Gist;

    // fullPage keeps today's full capture; the default view builds on the
    // op's chrome-free module join (issue #424).
    const fullPage = toolInput.fullPage === true;
    let contentHtml = fullPage ? g.html : g.contentHtml;
    let strippedSection: string[] = [];
    let droppedPresetTokens = 0;
    let tokens = g.sampledDesignTokens ?? g.themeTokens ?? null;

    if (!fullPage) {
      // 1. Consent noise FIRST — defense in depth (extraction strips it,
      //    but runs recorded before the stripper, and JS-injected consent
      //    DOM, still carry it). Running it before the boilerplate strip
      //    keeps attribution honest: a consent modal repeated on every
      //    page would otherwise match a site-wide boilerplate candidate
      //    and be miscounted as chrome.
      const consent = stripConsentSubtrees(contentHtml);
      contentHtml = consent.html;
      // 2. Repeated layout/template-owned blocks, per the run's OWN
      //    boilerplate classification (issue #424 — the data existed, the
      //    read ignored it). Catches chrome NOT at header/footer module
      //    boundaries: site-wide CTA banners, in-content nav zones.
      let chrome: readonly StrippedChromeBlock[] = [];
      let chromeNote: string | null = null;
      if (g.boilerplateSummary === null || g.boilerplateSummary === undefined) {
        chromeNote =
          "this run has no boilerplate summary (detect_import_boilerplate has not run on it). Treat blocks repeated across pages as shared, not per-page content.";
      } else {
        const summary = boilerplateSummarySchema.safeParse(g.boilerplateSummary);
        if (!summary.success) {
          chromeNote =
            "the stored boilerplate summary does not match the expected shape (schema drift; re-run detect_import_boilerplate).";
        } else {
          const res = stripBoilerplateSubtrees(
            contentHtml,
            summary.data.candidates as readonly BoilerplateStripTarget[],
          );
          contentHtml = res.html;
          chrome = res.stripped;
        }
      }
      // 3. Desktop + mobile duplicate-nav collapse.
      const navs = collapseDuplicateNavs(contentHtml);
      contentHtml = navs.html;
      // 4. Token facet: measured samples win; the raw :root dump is
      //    filtered to values the surviving content actually references.
      if (g.sampledDesignTokens === null || g.sampledDesignTokens === undefined) {
        const rawTokens = g.themeTokens;
        if (rawTokens !== null && typeof rawTokens === "object" && !Array.isArray(rawTokens)) {
          const filtered = filterPresetThemeTokens(
            rawTokens as Record<string, string>,
            contentHtml,
          );
          tokens = filtered.tokens;
          droppedPresetTokens = filtered.droppedPresetTokens;
        }
      }
      strippedSection = [
        "## Stripped from this read (content-only view — opt out with fullPage: true)",
        ...strippedCounterLines({
          chromeModuleBlocks: g.chromeModuleBlocks,
          chrome,
          chromeNote,
          consentRemoved: consent.removed,
          duplicateNavs: navs.removed,
          droppedPresetTokens,
        }),
        "",
      ];
    }

    const markdown = htmlToMarkdown(contentHtml);
    // Cache under a pageRef so query_page_html / read_page_more work on this
    // stored page exactly as they do on a live inspect_external_page result.
    // The cache keeps the FULL capture (not the stripped view) so
    // query_page_html can still pull a stripped section on demand.
    const pageRef = putPageInspection(toolCtx.chatSessionId ?? "no-session", {
      url: g.sourceUrl ?? `import:${g.importPageId}`,
      html: g.html,
      markdown,
    });
    const { text, nextCursor } = sliceMarkdown(markdown, 0);
    // In content-only mode a fully-filtered token dump must stay LOUD —
    // "{}" reads like an empty crawl, not like 47 dropped preset entries.
    const tokensEmptyAfterFilter =
      !fullPage &&
      droppedPresetTokens > 0 &&
      tokens !== null &&
      typeof tokens === "object" &&
      Object.keys(tokens as object).length === 0;
    const tokensDisplay = tokensEmptyAfterFilter
      ? `(none of this page's stored tokens are referenced by its content — ${droppedPresetTokens} unreferenced preset entries dropped, see Stripped section; fullPage: true returns the raw dump)`
      : tokens
        ? JSON.stringify(tokens, null, 2).slice(0, 2000)
        : "(none captured on this run)";
    const sections = [
      `# Imported page — ${g.sourceUrl ?? g.importPageId}`,
      // issue #422 — always emit the RESOLVED staging id (even when the
      // caller passed a built page id): it is the one id every follow-up
      // call takes (build_page.importPageId, check_page_content_inventory,
      // add_import_page_notes, get_import_page_screenshot).
      `Import page id: ${g.importPageId} (run ${g.runId}) — pass this as build_page's page.importPageId and to the verification/notes tools.`,
      `Page handle: ${pageRef} — reuse with read_page_more({ pageRef, cursor }) / query_page_html({ pageRef, ... }); no re-fetch.`,
      `Proposed slug: ${g.proposedSlug ?? "(none)"}`,
      `Proposed title: ${g.proposedTitle ?? "(none)"}`,
      "",
      ...strippedSection,
      "## Page text (Markdown)",
      text.length > 0 ? text : "(no readable text captured for this page)",
      nextCursor !== null
        ? `\n[truncated — ${markdown.length - text.length} more chars. Call read_page_more({ pageRef, cursor: ${nextCursor} }) for the rest.]`
        : "",
      "",
      "## Design tokens (crawled ground truth — cite these, never guess a palette)",
      tokensDisplay,
      "",
      "## Source screenshot",
      g.screenshotObjectKey
        ? "Stored — LOOK at it with get_import_page_screenshot({ importPageId, which: 'source' }) before you rebuild."
        : "No stored source screenshot — this page is UNVERIFIED; say so, do not claim you saw it.",
      "",
      "Rebuild with build_page: author FRESH semantic modules from the Markdown + screenshot + tokens above — never reproduce the source's page-builder markup. For one specific structure (a table, a form, a spec list) pull it with query_page_html({ pageRef, describe: '…' }).",
    ];
    return { ok: true, content: sections.join("\n") };
  },
};
