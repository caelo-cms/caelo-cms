// SPDX-License-Identifier: MPL-2.0

/**
 * issue #163 — Site Genesis draft tools; issue #375 generalises them
 * to growth-time design drafts (epic #149).
 *
 * One loop, two scopes. Site scope (Genesis): the AI drafts complete
 * freeform single-file HTML pages, one per direction, and the operator
 * picks — the design source the compiler (#164) derives the CMS
 * structure from. Page/module scope (#375): the AI drafts token-bound
 * FRAGMENTS of an existing surface; the preview composes each into the
 * site's real theme shell at view time, the operator picks inline in
 * the chat, and only the pick is materialised. The workflows live in
 * the `site-genesis` and `design-preview` skills (CLAUDE.md §2: skills
 * teach behaviour); these tools are their storage + presentation
 * surface.
 */

import { execute } from "@caelo-cms/query-api";
import { GENESIS_DRAFT_MAX_HTML_BYTES, genesisAddDraftInput } from "@caelo-cms/shared";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface ListedDraft {
  id: string;
  direction: string;
  rationale: string;
  status: string;
  scope: "site" | "page" | "module";
  targetPageId: string | null;
  targetModuleId: string | null;
  variantSetId: string;
  htmlBytes: number;
}

export const saveDesignDraftTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").GenesisAddDraftInput
> = {
  name: "save_design_draft",
  description:
    "Save ONE design draft; drafts live here, never paste draft HTML into chat.\n" +
    "USE FOR: design proposals, a redesign, 'options' for something existing -> draft variants first (design-preview skill); never restyle live modules to demo ideas.\n" +
    "DO NOT USE FOR: a concrete small instruction ('make the button red') -> edit directly.\n" +
    "CORE RULES: one round = one set: the first save returns `variantSetId`; pass it on every sibling save, then call `present_design_variants`. Revise after feedback = a NEW draft in the same set, same direction, rationale noting the change.",
  schema: genesisAddDraftInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["direction", "html"],
    properties: {
      direction: { type: "string", minLength: 3, maxLength: 120 },
      rationale: { type: "string", maxLength: 1000 },
      html: {
        type: "string",
        minLength: 200,
        maxLength: GENESIS_DRAFT_MAX_HTML_BYTES,
        description:
          "scope `site`: complete self-contained single-file page for one direction (all CSS inline, real copy, no external scripts/images). scope `page`/`module`: a FRAGMENT restyling the target: its section markup + one `<style>` block using the site's `var(--…)` theme tokens, with the target's REAL copy and imagery; previewed inside the real theme shell, so invented token names render visibly broken.",
      },
      scope: {
        type: "string",
        enum: ["site", "page", "module"],
        description:
          "Default `site` (Genesis / full redesign). `page`/`module` = variant of an existing surface.",
      },
      targetPageId: {
        type: "string",
        format: "uuid",
        description:
          "Required for scope `page` (the page redesigned); optional context for `module`.",
      },
      targetModuleId: {
        type: "string",
        format: "uuid",
        description: "Required for scope `module` (the module restyled).",
      },
      variantSetId: {
        type: "string",
        format: "uuid",
        description:
          "Omit on a round's first save (minted + returned); pass it on every sibling save.",
      },
      sourceKind: {
        type: "string",
        enum: ["genesis", "byod_image", "byod_html"],
        description:
          "Default `genesis`. Site scope only, when the operator supplied the design: `byod_image` = your faithful reproduction of their attached mockup (needs `referenceAssetId`; the parity gate verifies against THEIR image) | `byod_html` = HTML they provided (scripts are stripped; tell them if theirs relied on scripts).",
      },
      referenceAssetId: {
        type: "string",
        format: "uuid",
        description: "Required for `byod_image`: the attachment's assetId.",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "genesis.add_draft", input);
    if (!r.ok) {
      return { ok: false, content: `genesis.add_draft failed: ${describeError(r.error)}` };
    }
    const v = r.value as { draftId: string; variantSetId: string; candidateCount: number };
    const where =
      input.scope === "site"
        ? "compare at /design/genesis"
        : "call present_design_variants({variantSetId}) when the round is complete";
    return {
      ok: true,
      content: `draft ${v.draftId} ("${input.direction}", ${input.scope}) saved — set ${v.variantSetId} now holds ${v.candidateCount} candidate${v.candidateCount === 1 ? "" : "s"}; ${where}.`,
      value: { draftId: v.draftId, variantSetId: v.variantSetId },
    };
  },
};

const listInput = z
  .object({
    scope: z.enum(["site", "page", "module"]).optional(),
    variantSetId: z.string().uuid().optional(),
    targetPageId: z.string().uuid().optional(),
    targetModuleId: z.string().uuid().optional(),
  })
  .strict();

export const listDesignDraftsTool: ToolDefinitionWithHandler<z.infer<typeof listInput>> = {
  name: "list_design_drafts",
  description:
    "List design drafts' metadata (id, scope, target, variant set, direction, rationale, status, size; never HTML). Filter to see one comparison round. " +
    "Use before drafting new variants, or to get the draftId for `select_design_draft` after the operator picked.",
  schema: listInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      scope: { type: "string", enum: ["site", "page", "module"] },
      variantSetId: { type: "string", format: "uuid" },
      targetPageId: { type: "string", format: "uuid" },
      targetModuleId: { type: "string", format: "uuid" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "genesis.list_drafts", {
      includeHtml: false,
      ...input,
    });
    if (!r.ok) {
      return { ok: false, content: `genesis.list_drafts failed: ${describeError(r.error)}` };
    }
    const drafts = (r.value as { drafts: ListedDraft[] }).drafts;
    if (drafts.length === 0) {
      return {
        ok: true,
        content:
          "No design drafts match — run the site-genesis flow (brief → parallel draft subagents → save_design_draft) or the design-preview flow (scope page/module).",
      };
    }
    const target = (d: ListedDraft) =>
      d.scope === "module"
        ? ` module ${d.targetModuleId}`
        : d.scope === "page"
          ? ` page ${d.targetPageId}`
          : "";
    const lines = drafts.map(
      (d) =>
        `- ${d.id} [${d.status}] ${d.scope}${target(d)} set ${d.variantSetId} "${d.direction}" (${Math.round(d.htmlBytes / 1024)} KB)${d.rationale ? ` — ${d.rationale.split("\n")[0]}` : ""}`,
    );
    return {
      ok: true,
      content: `${drafts.length} draft(s):\n${lines.join("\n")}`,
      value: { drafts },
    };
  },
};

const presentInput = z
  .object({
    variantSetId: z.string().uuid(),
    /** One short line naming what the variants are for, shown as the
     *  card heading ("Hero section — 3 design variants"). */
    heading: z.string().min(3).max(120).optional(),
  })
  .strict();

/**
 * Canonical content shape (DesignVariantsCard contract — line-based,
 * mirrors offer_choices):
 *
 *   "Design variants ready: <heading>\n
 *    set <variantSetId>\n
 *    - <draftId> | <direction> | <one-line rationale>\n…"
 *
 * The card iframes each draft via /design/drafts/<id>/preview (the
 * theme-shell composition happens server-side there) and posts the
 * pick back as the operator's message.
 */
export const presentDesignVariantsTool: ToolDefinitionWithHandler<z.infer<typeof presentInput>> = {
  name: "present_design_variants",
  description:
    "Render a saved variant set INLINE IN CHAT, each draft previewed in the site's real theme with a pick button. Call ONCE after saving all of a round's drafts via `save_design_draft` (prefer 2–4; one option is a confirmation, not a choice).\n" +
    "Then END YOUR TURN: the pick arrives as the operator's next message (with the draft id) -> `select_design_draft`, then materialise. Prose feedback instead -> save revised drafts into the SAME set, present again.",
  schema: presentInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["variantSetId"],
    properties: {
      variantSetId: { type: "string", format: "uuid" },
      heading: { type: "string", minLength: 3, maxLength: 120 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "genesis.list_drafts", {
      includeHtml: false,
      variantSetId: input.variantSetId,
    });
    if (!r.ok) {
      return { ok: false, content: `genesis.list_drafts failed: ${describeError(r.error)}` };
    }
    const drafts = (r.value as { drafts: ListedDraft[] }).drafts;
    if (drafts.length === 0) {
      return {
        ok: false,
        content: `variant set ${input.variantSetId} has no drafts — save_design_draft returns the set id of the round it saved into; use that one`,
      };
    }
    // Rationale rides one line of the card contract — flatten defensively.
    const oneLine = (s: string) => s.replaceAll("\n", " ").replaceAll("|", "/").trim();
    const lines = drafts.map(
      (d) => `- ${d.id} | ${oneLine(d.direction)} | ${oneLine(d.rationale)}`,
    );
    const heading = input.heading ?? `${drafts.length} design variants`;
    return {
      ok: true,
      content: `Design variants ready: ${oneLine(heading)}\nset ${input.variantSetId}\n${lines.join("\n")}`,
      value: { variantSetId: input.variantSetId, draftIds: drafts.map((d) => d.id) },
    };
  },
};

const selectInput = z.object({ draftId: z.string().uuid() }).strict();

export const selectDesignDraftTool: ToolDefinitionWithHandler<z.infer<typeof selectInput>> = {
  name: "select_design_draft",
  description:
    "Mark ONE draft as chosen in its variant set, ONLY after the operator EXPLICITLY picked (variant card, /design/genesis, or in words); the choice is never yours. Re-selecting later is one call (the previous one reverts to candidate).\n" +
    "After a SITE draft: derive the theme from its actual palette/typography (`propose_create_theme`), build pages re-expressing its sections, never a different design. After a PAGE/MODULE variant: materialise on the chat branch (`update_modules_many` / the page's modules), transferring the token-bound fragment faithfully (`inspect_design_draft({draftId, includeHtml:true})` returns it).",
  schema: selectInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["draftId"],
    properties: { draftId: { type: "string", format: "uuid" } },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "genesis.select_draft", input);
    if (!r.ok) {
      return { ok: false, content: `genesis.select_draft failed: ${describeError(r.error)}` };
    }
    const prev = (r.value as { previousSelectedId: string | null }).previousSelectedId;
    return {
      ok: true,
      content: `draft ${input.draftId} is now the selected design${prev ? ` (replaced ${prev})` : ""}. Materialise FROM this draft — never a different design than the one chosen.`,
    };
  },
};
