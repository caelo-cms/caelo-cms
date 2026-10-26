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
    "Verify a rebuilt imported page lost NO source content — call right AFTER rebuilding it with `build_page`. Returns coverage + a LOUD list of every missing heading, paragraph, list item, image, link or CTA (with source context).\n" +
    "Content is sacred: restore anything genuinely dropped, or record WHY via `add_import_page_notes` — never let content vanish silently.",
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
          "Staging import_pages id (`list_import_pages` / `get_import_page`; ALWAYS resolves) OR built CMS page id (matched via build_page's importPageId link, slug, or home-page designation). Built page not found (custom/translated slug) -> pass the staging id; import data never expires, a miss = id/slug mismatch.",
      },
      includeChrome: {
        type: "boolean",
        description:
          "Include source header/footer; default false — chrome is verified once at the layout.",
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
    "Find content blocks repeating across a crawled run's pages (CTA banners, newsletter boxes, breadcrumb zones, author bios, in-content nav). BOILERPLATE: rebuild each as ONE shared module at the suggested level (layout = site-wide chrome | template = per-page-type block | shared content_instance = fixed block on a page subset), never copied into every page. Call AFTER clustering, BEFORE rebuilding pages.\n" +
    "Returns per candidate: page count, fixed vs per-page text (breadcrumbs vary -> template values fill per page), suggested placement + reason.",
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
        description: "Min pages a block must recur on. Default 3.",
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
