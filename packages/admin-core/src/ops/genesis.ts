// SPDX-License-Identifier: MPL-2.0

/**
 * issue #163 — Site Genesis ops; issue #375 generalises them to
 * growth-time design drafts (epic #149, two-level architecture).
 *
 * Site-scope drafts are complete freeform single-file HTML pages, one
 * per design direction, produced by parallel draft subagents at
 * design-time — the Genesis case, unchanged. Page/module-scope drafts
 * (#375) are FRAGMENTS bound to the site's `var(--…)` tokens; the
 * render op composes one into the site's real theme shell (fonts,
 * theme vars, technical baseline) at view time, so a variant previews
 * exactly as it will materialise and never freezes a stale theme copy.
 *
 * One request's variants share a `variant_set`; the operator compares
 * a set side-by-side (inline chat card or /design/genesis) and exactly
 * one draft per set becomes `selected`. The site-scope invariant from
 * 0105 — at most one selected SITE draft overall — survives on top:
 * "the chosen design" must stay unambiguous for the compiler.
 *
 * All ops are routine (`human + ai + system`): drafts are candidates
 * with zero blast radius until materialisation runs through the
 * existing gates (theme propose/execute, branch-scoped module edits).
 * Selection itself is one-click revertable (select a different draft),
 * so per §11.A it stays ungated — but the AI's skills instruct it to
 * select only after the operator explicitly chose.
 */

import { defineOperation } from "@caelo-cms/query-api";
import {
  type ComposeFonts,
  composeDesignDraftShell,
  designDraftFormat,
  designDraftScope,
  draftFormatForScope,
  err,
  fontUnresolvableMarker,
  genesisAddDraftInput,
  genesisDraftSourceKind,
  genesisDraftStatus,
  ok,
  sanitizeDraftHtml,
} from "@caelo-cms/shared";
import { defaultFontsCacheDir, resolveThemeFonts } from "@caelo-cms/static-generator";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { toIsoRequired } from "./_helpers.js";
import { loadActiveThemeForCompose } from "./content/preview.js";

const draftRow = z.object({
  id: z.string(),
  direction: z.string(),
  rationale: z.string(),
  status: genesisDraftStatus,
  /** issue #375 — what the draft covers + how its HTML is stored. */
  scope: designDraftScope,
  format: designDraftFormat,
  targetPageId: z.string().nullable(),
  targetModuleId: z.string().nullable(),
  variantSetId: z.string(),
  /** issue #199 — provenance + the byod_image parity reference. */
  sourceKind: genesisDraftSourceKind,
  referenceAssetId: z.string().nullable(),
  createdAt: z.string(),
  /** Byte size instead of the body — listing is a decision surface. */
  htmlBytes: z.number().int().nonnegative(),
  /** Present only when `includeHtml: true` (the selection UI's iframes). */
  html: z.string().optional(),
});

export const addGenesisDraftOp = defineOperation({
  name: "genesis.add_draft",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: genesisAddDraftInput,
  output: z.object({
    draftId: z.string(),
    variantSetId: z.string(),
    /** Candidates in THIS draft's variant set (the comparison size). */
    candidateCount: z.number().int(),
  }),
  handler: async (ctx, input, tx) => {
    // issue #199 — operator-provided HTML is sanitised at the boundary;
    // AI-authored drafts pass through (they never contain scripts by
    // the authoring rules, and sanitising anyway costs nothing).
    const html = sanitizeDraftHtml(input.html);
    if (input.sourceKind === "byod_image" && !input.referenceAssetId) {
      return err({
        kind: "HandlerError",
        operation: "genesis.add_draft",
        message:
          "byod_image drafts need referenceAssetId (the uploaded mockup) — the parity gate compares against the operator's asset",
      });
    }
    const format = draftFormatForScope(input.scope);

    // issue #375 — resolve the variant set. Explicit id must belong to
    // a consistent set (same scope + target); site scope without an id
    // continues the one Genesis comparison; page/module without an id
    // start a fresh round.
    let variantSetId = input.variantSetId ?? null;
    if (variantSetId !== null) {
      const sibling = (await tx.execute(sql`
        SELECT scope, target_page_id::text AS target_page_id,
               target_module_id::text AS target_module_id
        FROM genesis_drafts WHERE variant_set = ${variantSetId}::uuid LIMIT 1
      `)) as unknown as {
        scope: string;
        target_page_id: string | null;
        target_module_id: string | null;
      }[];
      const s = sibling[0];
      if (
        s !== undefined &&
        (s.scope !== input.scope ||
          s.target_page_id !== (input.targetPageId ?? null) ||
          s.target_module_id !== (input.targetModuleId ?? null))
      ) {
        return err({
          kind: "HandlerError",
          operation: "genesis.add_draft",
          message: `variantSetId ${variantSetId} belongs to a ${s.scope}-scope set with a different target — omit variantSetId to start a new set, or pass the id the first save of THIS round returned`,
        });
      }
    } else if (input.scope === "site") {
      const existing = (await tx.execute(sql`
        SELECT variant_set::text AS variant_set FROM genesis_drafts
        WHERE scope = 'site' ORDER BY created_at DESC LIMIT 1
      `)) as unknown as { variant_set: string }[];
      variantSetId = existing[0]?.variant_set ?? null;
    }

    const rows = (await tx.execute(sql`
      INSERT INTO genesis_drafts
        (direction, rationale, html, source_kind, reference_asset_id,
         scope, format, target_page_id, target_module_id, variant_set)
      VALUES (${input.direction}, ${input.rationale}, ${html},
              ${input.sourceKind}, ${input.referenceAssetId ?? null}::uuid,
              ${input.scope}, ${format},
              ${input.targetPageId ?? null}::uuid, ${input.targetModuleId ?? null}::uuid,
              COALESCE(${variantSetId}::uuid, gen_random_uuid()))
      RETURNING id::text AS id, variant_set::text AS variant_set
    `)) as unknown as { id: string; variant_set: string }[];
    const inserted = rows[0];
    if (!inserted) {
      return err({
        kind: "HandlerError",
        operation: "genesis.add_draft",
        message: "insert returned no row",
      });
    }
    const count = (await tx.execute(sql`
      SELECT COUNT(*)::int AS n FROM genesis_drafts
      WHERE status = 'candidate' AND variant_set = ${inserted.variant_set}::uuid
    `)) as unknown as { n: number | string }[];
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "genesis.add_draft",
      input: {
        direction: input.direction,
        scope: input.scope,
        targetPageId: input.targetPageId,
        targetModuleId: input.targetModuleId,
        variantSetId: inserted.variant_set,
        htmlBytes: input.html.length,
      },
      succeeded: true,
      resultSummary: `draft ${inserted.id} (${input.scope}: ${input.direction})`,
    });
    return ok({
      draftId: inserted.id,
      variantSetId: inserted.variant_set,
      candidateCount: Number(count[0]?.n ?? 0),
    });
  },
});

export const listGenesisDraftsOp = defineOperation({
  name: "genesis.list_drafts",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      includeHtml: z.boolean().default(false),
      /** issue #375 — narrow the listing; omit everything for all drafts. */
      scope: designDraftScope.optional(),
      variantSetId: z.string().uuid().optional(),
      targetPageId: z.string().uuid().optional(),
      targetModuleId: z.string().uuid().optional(),
    })
    .strict(),
  output: z.object({ drafts: z.array(draftRow) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, direction, rationale, status,
             scope, format,
             target_page_id::text AS target_page_id,
             target_module_id::text AS target_module_id,
             variant_set::text AS variant_set,
             source_kind, reference_asset_id::text AS reference_asset_id,
             created_at, length(html)::int AS html_bytes
             ${input.includeHtml ? sql`, html` : sql``}
      FROM genesis_drafts
      WHERE status <> 'discarded'
        AND (${input.scope ?? null}::text IS NULL OR scope = ${input.scope ?? null}::text)
        AND (${input.variantSetId ?? null}::uuid IS NULL OR variant_set = ${input.variantSetId ?? null}::uuid)
        AND (${input.targetPageId ?? null}::uuid IS NULL OR target_page_id = ${input.targetPageId ?? null}::uuid)
        AND (${input.targetModuleId ?? null}::uuid IS NULL OR target_module_id = ${input.targetModuleId ?? null}::uuid)
      ORDER BY created_at ASC
    `)) as unknown as {
      id: string;
      direction: string;
      rationale: string;
      status: "candidate" | "selected" | "discarded";
      scope: "site" | "page" | "module";
      format: "document" | "fragment";
      target_page_id: string | null;
      target_module_id: string | null;
      variant_set: string;
      source_kind: "genesis" | "byod_image" | "byod_html";
      reference_asset_id: string | null;
      created_at: string | Date;
      html_bytes: number;
      html?: string;
    }[];
    return ok({
      drafts: rows.map((r) => ({
        id: r.id,
        direction: r.direction,
        rationale: r.rationale,
        status: r.status,
        scope: r.scope,
        format: r.format,
        targetPageId: r.target_page_id,
        targetModuleId: r.target_module_id,
        variantSetId: r.variant_set,
        sourceKind: r.source_kind,
        referenceAssetId: r.reference_asset_id,
        createdAt: toIsoRequired(r.created_at, "genesis_drafts.created_at"),
        htmlBytes: r.html_bytes,
        ...(r.html !== undefined ? { html: r.html } : {}),
      })),
    });
  },
});

export const selectGenesisDraftOp = defineOperation({
  name: "genesis.select_draft",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ draftId: z.string().uuid() }).strict(),
  output: z.object({ previousSelectedId: z.string().nullable() }),
  handler: async (ctx, input, tx) => {
    const target = (await tx.execute(sql`
      SELECT id::text AS id, status, scope, variant_set::text AS variant_set
      FROM genesis_drafts
      WHERE id = ${input.draftId}::uuid LIMIT 1
    `)) as unknown as { id: string; status: string; scope: string; variant_set: string }[];
    const row = target[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "genesis.select_draft",
        message: "draft not found — call genesis.list_drafts for current draft ids",
      });
    }
    if (row.status === "discarded") {
      return err({
        kind: "HandlerError",
        operation: "genesis.select_draft",
        message: "draft was discarded — save a fresh draft or pick a candidate",
      });
    }
    // Demote-then-promote inside the op's transaction; the partial
    // unique indexes back both invariants at the DB layer. Demotion
    // covers the draft's own variant set AND — for site scope — any
    // other selected site draft (one chosen design overall).
    const prev = (await tx.execute(sql`
      UPDATE genesis_drafts SET status = 'candidate'
      WHERE status = 'selected' AND id <> ${input.draftId}::uuid
        AND (variant_set = ${row.variant_set}::uuid
             OR (${row.scope} = 'site' AND scope = 'site'))
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    await tx.execute(sql`
      UPDATE genesis_drafts SET status = 'selected' WHERE id = ${input.draftId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "genesis.select_draft",
      input,
      succeeded: true,
      resultSummary: `selected ${input.draftId}${prev[0] ? ` (was ${prev[0].id})` : ""}`,
    });
    return ok({ previousSelectedId: prev[0]?.id ?? null });
  },
});

/**
 * issue #375 — compose one draft into renderable preview HTML.
 *
 * Documents (site scope) pass through unchanged. Fragments compose
 * into the site's REAL theme shell: active theme row + resolved web
 * fonts through the SAME pipeline `pages.render_preview` uses, so the
 * preview shows the variant in the site's actual fonts/palette/base
 * styles. Renders against the LIVE theme (no branch overlay): the
 * draft loop precedes materialisation, which is where branch semantics
 * begin. Unresolvable fonts degrade like the page preview (loud in
 * missingSlots, never a blocked render); a missing theme renders the
 * shell without theme vars — visibly broken on purpose (§2).
 */
export const renderDesignDraftOp = defineOperation({
  name: "genesis.render_draft",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ draftId: z.string().uuid() }).strict(),
  output: z.object({
    html: z.string(),
    scope: designDraftScope,
    format: designDraftFormat,
    direction: z.string(),
    missingSlots: z.array(z.string()),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT direction, html, scope, format FROM genesis_drafts
      WHERE id = ${input.draftId}::uuid AND status <> 'discarded' LIMIT 1
    `)) as unknown as {
      direction: string;
      html: string;
      scope: "site" | "page" | "module";
      format: "document" | "fragment";
    }[];
    const draft = rows[0];
    if (!draft) {
      return err({
        kind: "HandlerError",
        operation: "genesis.render_draft",
        message: "draft not found or discarded — call genesis.list_drafts for current draft ids",
      });
    }
    if (draft.format === "document") {
      return ok({
        html: draft.html,
        scope: draft.scope,
        format: draft.format,
        direction: draft.direction,
        missingSlots: [],
      });
    }
    const theme = await loadActiveThemeForCompose(tx, undefined);
    const missingSlots: string[] = [];
    let fonts: ComposeFonts | undefined;
    if (theme !== undefined) {
      const resolved = await resolveThemeFonts({
        tokens: theme.tokens,
        cacheDir: defaultFontsCacheDir(process.cwd()),
        publicBasePath: "/_caelo/fonts",
      });
      if (resolved.css.length > 0) {
        fonts = { css: resolved.css, preloads: resolved.preloads };
      }
      for (const family of resolved.unresolved) {
        missingSlots.push(fontUnresolvableMarker(family));
      }
    } else {
      missingSlots.push("theme-missing");
    }
    const shell = composeDesignDraftShell({
      fragmentHtml: draft.html,
      theme,
      fonts,
      title: `Design draft — ${draft.direction}`,
    });
    return ok({
      html: shell.html,
      scope: draft.scope,
      format: draft.format,
      direction: draft.direction,
      missingSlots: [...missingSlots, ...shell.missingSlots],
    });
  },
});
