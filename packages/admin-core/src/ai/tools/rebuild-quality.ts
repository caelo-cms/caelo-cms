// SPDX-License-Identifier: MPL-2.0

/**
 * issue #248 (WS2) — the rebuild-quality checks the migration AI runs
 * while rebuilding a crawled site as clean Caelo modules.
 *
 * The REBUILD CONTRACT (skill 0130) says: content is sacred, markup is
 * rebuildable, improve-by-default. These two tools are the enforcement
 * the contract leans on:
 *
 *   - `check_page_content_inventory` — after rebuilding a page, prove no
 *     heading / paragraph / list item / image / link / CTA was lost.
 *   - `detect_import_boilerplate` — before rebuilding, find the blocks
 *     that repeat across pages so each becomes ONE shared module at the
 *     right level instead of copied content on every page.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const inventoryInput = z
  .object({
    importPageId: z.string().uuid(),
    includeChrome: z.boolean().optional(),
  })
  .strict();
type InventoryInput = z.infer<typeof inventoryInput>;

interface InventoryResult {
  total: number;
  covered: number;
  missing: number;
  missingByKind: Record<string, number>;
  missingItems: {
    kind: string;
    text: string | null;
    href: string | null;
    src: string | null;
    sourceContext: string | null;
  }[];
}

export const checkPageContentInventoryTool: ToolDefinitionWithHandler<InventoryInput> = {
  name: "check_page_content_inventory",
  description:
    "Verify a rebuilt imported page lost NO content from the source. Call it right AFTER you rebuild a page's modules (and after compose_from_import created it). It compares the source page's crawled content against the rebuilt modules and returns what is covered plus a LOUD list of every missing heading, paragraph, list item, image, link, or CTA (with the source context so you can find it). Content is sacred: restore anything genuinely dropped, or record WHY you dropped it (add_import_page_notes) so the operator sees it — never let content vanish silently. Chrome (header/footer) is excluded by default because it is layout-owned. `importPageId` accepts EITHER the staging import_pages id OR the composed CMS page id.",
  schema: inventoryInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["importPageId"],
    properties: {
      importPageId: {
        type: "string",
        format: "uuid",
        description:
          "The page to check — pass EITHER the staging import_pages id OR the composed CMS page id (accepted_page_id).",
      },
      includeChrome: {
        type: "boolean",
        description:
          "Include the source header/footer in the check. Default false — chrome is verified once at the layout, not per page.",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "imports.check_page_inventory",
      input,
    );
    if (!r.ok) {
      return {
        ok: false,
        content: `check_page_content_inventory failed: ${describeError(r.error)}`,
      };
    }
    const v = r.value as InventoryResult;
    if (v.missing === 0) {
      return {
        ok: true,
        content: `Content inventory: all ${v.total} source items are present in the rebuild. No information lost.`,
      };
    }
    const byKind = Object.entries(v.missingByKind)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`)
      .join(", ");
    const samples = v.missingItems
      .slice(0, 20)
      .map((m) => {
        const label = m.text ?? m.href ?? m.src ?? "(no text)";
        const where = m.sourceContext ? ` [under "${m.sourceContext}"]` : "";
        return `- ${m.kind}: ${label}${where}`;
      })
      .join("\n");
    return {
      ok: true,
      content: [
        `Content inventory: ${v.missing} of ${v.total} source items are MISSING from the rebuild (${byKind}).`,
        "A loud content_missing note was recorded for this page.",
        "Restore each item in the rebuilt modules, OR add an add_import_page_notes note saying why it was intentionally dropped. Do not leave content silently missing.",
        "",
        samples,
      ].join("\n"),
    };
  },
};

const boilerplateInput = z
  .object({
    runId: z.string().uuid(),
    minPages: z.number().int().min(2).max(500).optional(),
  })
  .strict();
type BoilerplateInput = z.infer<typeof boilerplateInput>;

interface BoilerplateResult {
  pagesAnalyzed: number;
  candidates: {
    kind: string;
    tag: string;
    pageCount: number;
    contentVaries: boolean;
    clusterKeys: string[];
    sampleText: string;
    suggestedPlacement: string;
    placementReason: string;
  }[];
}

export const detectImportBoilerplateTool: ToolDefinitionWithHandler<BoilerplateInput> = {
  name: "detect_import_boilerplate",
  description:
    "Find the content blocks that repeat across a crawled run's pages — CTA banners, newsletter boxes, breadcrumb zones, author bios, in-content nav. These are BOILERPLATE, not per-page content: rebuild each as ONE shared module at the suggested level (layout for site-wide chrome, template for a per-page-type block, a shared content_instance for a fixed block recurring on a subset of pages), never copied into every page. Call it AFTER clustering and BEFORE rebuilding the pages, so your rebuild plan reuses instead of duplicates. Returns each candidate with its page count, whether its text is fixed or varies per page (breadcrumbs vary → template values fill per page), and the suggested placement with a reason.",
  schema: boilerplateInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["runId"],
    properties: {
      runId: { type: "string", format: "uuid" },
      minPages: {
        type: "integer",
        minimum: 2,
        maximum: 500,
        description: "A block must recur on at least this many pages to count. Default 3.",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "imports.detect_boilerplate",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `detect_import_boilerplate failed: ${describeError(r.error)}` };
    }
    const v = r.value as BoilerplateResult;
    if (v.candidates.length === 0) {
      return {
        ok: true,
        content: `No repeated blocks found across ${v.pagesAnalyzed} pages — nothing reads as boilerplate. Rebuild pages normally.`,
      };
    }
    const lines = v.candidates.map((c) => {
      const variance = c.contentVaries ? "varies per page" : "identical everywhere";
      const clusters = c.clusterKeys.length > 0 ? ` clusters: ${c.clusterKeys.join(", ")};` : "";
      return `- <${c.tag}> on ${c.pageCount} pages (${variance});${clusters} → ${c.suggestedPlacement}: ${c.placementReason}\n    "${c.sampleText}"`;
    });
    return {
      ok: true,
      content: [
        `${v.candidates.length} boilerplate block(s) detected across ${v.pagesAnalyzed} pages:`,
        ...lines,
        "",
        "Rebuild each ONCE at its suggested level and reference it — do not copy it into every page. Bind site-wide blocks on the layout, per-page-type blocks on the template, and recurring fixed blocks as a shared synced content_instance.",
      ].join("\n"),
    };
  },
};
