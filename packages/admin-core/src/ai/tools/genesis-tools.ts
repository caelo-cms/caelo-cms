// SPDX-License-Identifier: MPL-2.0

/**
 * issue #163 — Site Genesis AI tools (epic #149).
 *
 * Design-time is divergent: the AI drafts complete freeform single-file
 * HTML pages (one per direction, produced by parallel `spawn_subagents`)
 * and the OPERATOR picks one — the design source the compiler (#164)
 * derives the CMS structure from. The workflow itself lives in the
 * `site-genesis` skill (CLAUDE.md §2: skills teach behaviour); these
 * tools are its storage surface.
 */

import { execute } from "@caelo-cms/query-api";
import { GENESIS_DRAFT_MAX_HTML_BYTES, genesisAddDraftInput } from "@caelo-cms/shared";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const saveGenesisDraftTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").GenesisAddDraftInput
> = {
  name: "save_genesis_draft",
  description:
    "Save ONE Site Genesis design draft: a complete self-contained single-file HTML page for one design direction (all CSS inline, real copy, no external scripts/images). " +
    "Part of the site-genesis flow — save each draft your parallel subagents return, then point the operator at /design/genesis to compare them side-by-side. " +
    "Do NOT paste draft HTML into the chat (it's huge and unreadable there); this tool is where drafts live. " +
    "`direction` names the design angle ('bold editorial'); `rationale` says why it fits the brief — both render beside the preview so the operator can choose without reading code. " +
    "To revise a draft after feedback, save a NEW draft with the same direction and a rationale noting the change. " +
    "BRING-YOUR-OWN-DESIGN (issue #199): when the operator supplied the design, set sourceKind — 'byod_image' for your faithful reproduction of their attached mockup (referenceAssetId REQUIRED: the attachment's assetId; the parity gate then verifies against THEIR image, not your reproduction) or 'byod_html' for HTML they provided (scripts are stripped at the boundary — tell them if theirs relied on scripts).",
  schema: genesisAddDraftInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["direction", "html"],
    properties: {
      direction: { type: "string", minLength: 3, maxLength: 120 },
      rationale: { type: "string", maxLength: 1000 },
      html: { type: "string", minLength: 200, maxLength: GENESIS_DRAFT_MAX_HTML_BYTES },
      sourceKind: {
        type: "string",
        enum: ["genesis", "byod_image", "byod_html"],
        description: "Where this draft came from. Default 'genesis' (divergent AI drafts).",
      },
      referenceAssetId: {
        type: "string",
        format: "uuid",
        description: "byod_image only: the operator's uploaded mockup asset.",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "genesis.add_draft", input);
    if (!r.ok) {
      return { ok: false, content: `genesis.add_draft failed: ${describeError(r.error)}` };
    }
    const v = r.value as { draftId: string; candidateCount: number };
    return {
      ok: true,
      content: `draft ${v.draftId} ("${input.direction}") saved — ${v.candidateCount} candidate${v.candidateCount === 1 ? "" : "s"} now at /design/genesis.`,
    };
  },
};

const listInput = z.object({}).strict();

export const listGenesisDraftsTool: ToolDefinitionWithHandler<z.infer<typeof listInput>> = {
  name: "list_genesis_drafts",
  description:
    "List Site Genesis drafts (id, direction, rationale, status, size) — metadata only, never the HTML bodies. " +
    "Use to check what already exists before spawning new draft subagents, or to fetch the draftId for select_genesis_draft after the operator picked.",
  schema: listInput,
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  handler: async (ctx, _input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "genesis.list_drafts", {
      includeHtml: false,
    });
    if (!r.ok) {
      return { ok: false, content: `genesis.list_drafts failed: ${describeError(r.error)}` };
    }
    const drafts = (
      r.value as {
        drafts: {
          id: string;
          direction: string;
          rationale: string;
          status: string;
          htmlBytes: number;
        }[];
      }
    ).drafts;
    if (drafts.length === 0) {
      return {
        ok: true,
        content:
          "No Genesis drafts yet — run the site-genesis flow (brief → parallel draft subagents → save_genesis_draft).",
      };
    }
    const lines = drafts.map(
      (d) =>
        `- ${d.id} [${d.status}] "${d.direction}" (${Math.round(d.htmlBytes / 1024)} KB)${d.rationale ? ` — ${d.rationale}` : ""}`,
    );
    return {
      ok: true,
      content: `${drafts.length} draft(s):\n${lines.join("\n")}`,
      value: { drafts },
    };
  },
};

const selectInput = z.object({ draftId: z.string().uuid() }).strict();

export const selectGenesisDraftTool: ToolDefinitionWithHandler<z.infer<typeof selectInput>> = {
  name: "select_genesis_draft",
  description:
    "Mark ONE Genesis draft as the chosen design. ONLY call after the operator EXPLICITLY picked (in chat or at /design/genesis) — the design choice is theirs, never yours. " +
    "Selecting a different draft later is one call (the previous selection reverts to candidate). " +
    "After selecting: derive the theme from the SELECTED draft's actual palette/typography (propose_create_theme), then build pages that re-express its sections — never invent a different design than the one chosen.",
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
      content: `draft ${input.draftId} is now the selected design${prev ? ` (replaced ${prev})` : ""}. Derive the theme + pages FROM this draft.`,
    };
  },
};
