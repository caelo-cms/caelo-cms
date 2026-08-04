// SPDX-License-Identifier: MPL-2.0

/**
 * issue #164 — AI tool: inspect_design_draft (compiler stage 1);
 * renamed + scope-generalised by #375.
 *
 * After the operator selects a draft at /design/genesis, a LATER chat
 * session no longer has the draft HTML in context (listings are
 * metadata-only by design). This tool closes that gap AND runs the
 * deterministic inventory so the AI materialises the design from
 * facts, not from eyeballing raw CSS: distinct colors with usage
 * contexts + counts, gradients, font families, size/spacing/radius
 * histograms, shadows, and the section outline.
 *
 * Compiler contract: the AI decides (token names/roles, section →
 * module boundaries), code executes and counts. Later slices add the
 * mechanical token-map apply + the screenshot-parity loop.
 */

import { execute } from "@caelo-cms/query-api";
import { formatGenesisInventory, inventoryGenesisDraft } from "@caelo-cms/shared";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const inspectInput = z
  .object({
    /** Defaults to the selected SITE draft — the compiler's source.
     *  Growth-time variants (#375) are inspected by explicit id. */
    draftId: z.string().uuid().optional(),
    /**
     * Also return the raw HTML. Costly in context — fetch it only when
     * actually re-expressing sections as modules, not for theming.
     */
    includeHtml: z.boolean().default(false),
  })
  .strict();
type InspectInput = z.infer<typeof inspectInput>;

export const inspectDesignDraftTool: ToolDefinitionWithHandler<InspectInput> = {
  name: "inspect_design_draft",
  description:
    "Read a design draft as a design FACT BASE: distinct colors with usage counts + properties, gradients, font families, font-size/spacing/radius histograms, shadows, and the section outline. Without draftId it defaults to the selected SITE draft (the Genesis compiler's source); growth-time page/module variants (#375) are inspected by explicit draftId. " +
    "This is how you materialise a chosen design: for a SITE draft, derive the theme document from THIS inventory (the draft's exact palette/typefaces — never invent different ones), then re-express the outline's sections as modules; for a page/module variant, the fragment is already token-bound — transfer it faithfully. " +
    "Pass `includeHtml: true` ONLY when you need the markup itself (building or editing the modules) — the inventory alone answers every theming question at a fraction of the context.",
  schema: inspectInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      draftId: { type: "string", format: "uuid" },
      includeHtml: { type: "boolean", default: false },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "genesis.list_drafts", {
      includeHtml: true,
    });
    if (!r.ok) {
      return { ok: false, content: `genesis.list_drafts failed: ${describeError(r.error)}` };
    }
    const drafts = (
      r.value as {
        drafts: { id: string; direction: string; status: string; scope: string; html?: string }[];
      }
    ).drafts;
    const target =
      input.draftId !== undefined
        ? drafts.find((d) => d.id === input.draftId)
        : drafts.find((d) => d.status === "selected" && d.scope === "site");
    if (!target) {
      return {
        ok: false,
        content:
          input.draftId !== undefined
            ? "draft not found — call list_design_drafts for current ids"
            : "no site draft is selected yet — the operator picks at /design/genesis (or tells you in chat; then call select_design_draft)",
      };
    }
    const html = target.html ?? "";
    const inventory = inventoryGenesisDraft(html);
    const header = `Draft ${target.id} ("${target.direction}", ${target.status}) — ${Math.round(html.length / 1024)} KB`;
    const body = formatGenesisInventory(inventory);
    const htmlPart = input.includeHtml ? `\n\n--- HTML ---\n${html}` : "";
    return {
      ok: true,
      content: `${header}\n${body}${htmlPart}`,
      value: { draftId: target.id, direction: target.direction, inventory },
    };
  },
};
