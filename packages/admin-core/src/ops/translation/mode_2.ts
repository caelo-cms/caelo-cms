// SPDX-License-Identifier: MPL-2.0

/**
 * P10 — Mode 2: update an existing translation when the source page
 * has changed (variant.translated_from_hash !== source.content_hash).
 *
 * Per CMS_REQUIREMENTS §7.6: the AI receives the FULL source, the
 * FULL existing translation, and the structured diff — it updates
 * ONLY changed blocks and preserves prior translation quality on
 * unchanged ones. The handler enforces this: only modules referenced
 * in the diff's `changed` set get their HTML rewritten; others stay
 * verbatim.
 *
 * Adds and removes are flagged but not applied automatically — Mode 2
 * never breaks the structural lock. If the source has new modules,
 * the variant is left missing them and the handler reports the count;
 * the editor must run a fresh Mode 1 (or the structural editor) to
 * realign.
 */

import type { TransactionRunner } from "@caelo/query-api";
import { defineOperation } from "@caelo/query-api";
import {
  type BlockDiffOp,
  buildModeTwoPrompt,
  computeBlockDiff,
  err,
  type GlossaryEntry,
  type ModuleBlockSlot,
  ok,
  translationResultPayload,
} from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { emitSnapshot, loadPageLayoutState } from "../../snapshots/index.js";
import { recomputePageContentHash } from "../content/content_hash.js";
import {
  runTranslationProvider,
  stripJsonFence,
  type TranslationProviderHandle,
} from "./mode_1.js";

let injectedProvider: TranslationProviderHandle | null = null;
export function setMode2Provider(handle: TranslationProviderHandle | null): void {
  injectedProvider = handle;
}
function requireProvider(): TranslationProviderHandle {
  if (!injectedProvider) {
    throw new Error("translation provider not configured — call setTranslationProvider");
  }
  return injectedProvider;
}

const DEFAULT_INPUT_COST_PER_M = 15;
const DEFAULT_OUTPUT_COST_PER_M = 75;
function microcents(usd: number): number {
  return Math.round(usd * 1e8);
}

async function loadModuleSlots(tx: TransactionRunner, pageId: string): Promise<ModuleBlockSlot[]> {
  const rows = (await tx.execute(sql`
    SELECT pm.block_name AS block_name, pm.position AS position,
           m.id::text AS module_id, m.slug AS slug, m.html AS html
    FROM page_modules pm
    JOIN modules m ON m.id = pm.module_id AND m.deleted_at IS NULL
    WHERE pm.page_id = ${pageId}::uuid
    ORDER BY pm.block_name ASC, pm.position ASC
  `)) as unknown as {
    block_name: string;
    position: number;
    module_id: string;
    slug: string;
    html: string;
  }[];
  return rows.map((r) => ({
    blockName: r.block_name,
    position: r.position,
    moduleId: r.module_id,
    moduleSlug: r.slug,
    html: r.html,
    altText: null,
    caption: null,
  }));
}

async function loadGlossary(tx: TransactionRunner, locale: string): Promise<GlossaryEntry[]> {
  const rows = (await tx.execute(sql`
    SELECT source_term, translation, context FROM site_glossary
    WHERE locale = ${locale}
    ORDER BY source_term ASC
  `)) as unknown as { source_term: string; translation: string; context: string | null }[];
  return rows.map((r) => ({
    sourceTerm: r.source_term,
    translation: r.translation,
    context: r.context,
  }));
}

async function loadStyleGuide(tx: TransactionRunner, locale: string): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT body FROM site_style_guide WHERE locale = ${locale} LIMIT 1
  `)) as unknown as { body: string }[];
  return rows[0]?.body ?? null;
}

export const translationModeTwoOp = defineOperation({
  name: "translation.mode_2",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      pageId: z.string().uuid(),
      targetLocale: z.string().min(2).max(10),
    })
    .strict(),
  output: z.object({
    variantPageId: z.string(),
    blocksChanged: z.number().int().nonnegative(),
    blocksAdded: z.number().int().nonnegative(),
    blocksRemoved: z.number().int().nonnegative(),
    costMicrocents: z.number().int().nonnegative(),
  }),
  handler: async (ctx, input, tx) => {
    const handle = requireProvider();

    // Source page (the row passed in is the source — it carries the
    // canonical content_hash; the variant is found by (slug, target)).
    const sourceRows = (await tx.execute(sql`
      SELECT id::text AS id, slug, locale, content_hash
      FROM pages WHERE id = ${input.pageId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { id: string; slug: string; locale: string; content_hash: string | null }[];
    const source = sourceRows[0];
    if (!source) {
      return err({
        kind: "HandlerError",
        operation: "translation.mode_2",
        message: "source page not found",
      });
    }
    if (source.locale === input.targetLocale) {
      return err({
        kind: "HandlerError",
        operation: "translation.mode_2",
        message: "target locale matches source",
      });
    }
    const variantRows = (await tx.execute(sql`
      SELECT id::text AS id FROM pages
      WHERE slug = ${source.slug} AND locale = ${input.targetLocale} AND deleted_at IS NULL
      LIMIT 1
    `)) as unknown as { id: string }[];
    const variantPageId = variantRows[0]?.id;
    if (!variantPageId) {
      return err({
        kind: "HandlerError",
        operation: "translation.mode_2",
        message: `no variant exists for (slug=${source.slug}, locale=${input.targetLocale}) — use translation.mode_1 to create it`,
      });
    }
    const localeRows = (await tx.execute(sql`
      SELECT display_name FROM locales WHERE code = ${input.targetLocale} LIMIT 1
    `)) as unknown as { display_name: string }[];

    const sourceModules = await loadModuleSlots(tx, input.pageId);
    const variantModules = await loadModuleSlots(tx, variantPageId);
    const diff: BlockDiffOp[] = computeBlockDiff(sourceModules, variantModules);

    const changed = diff.filter((d) => d.kind === "changed");
    const added = diff.filter((d) => d.kind === "added");
    const removed = diff.filter((d) => d.kind === "removed");
    const blocksAdded = added.length;
    const blocksRemoved = removed.length;

    // Fast-path: no changes detected. Just bump translated_from_hash
    // so the dashboard reflects up_to_date without a wasteful AI call.
    if (changed.length === 0 && added.length === 0 && removed.length === 0) {
      await tx.execute(sql`
        UPDATE pages
        SET translated_from_hash = ${source.content_hash},
            translation_status = 'up_to_date',
            updated_at = now()
        WHERE id = ${variantPageId}::uuid
      `);
      await recordAudit(tx, {
        actorId: ctx.actorId,
        operation: "translation.mode_2",
        input,
        succeeded: true,
        entityId: variantPageId,
        resultSummary: `${source.slug}→${input.targetLocale} no-op (no diff)`,
      });
      return ok({
        variantPageId,
        blocksChanged: 0,
        blocksAdded: 0,
        blocksRemoved: 0,
        costMicrocents: 0,
      });
    }

    const glossary = await loadGlossary(tx, input.targetLocale);
    const styleGuide = await loadStyleGuide(tx, input.targetLocale);

    const { system, user } = buildModeTwoPrompt({
      sourceLocale: source.locale,
      targetLocale: input.targetLocale,
      targetLocaleDisplayName: localeRows[0]?.display_name,
      sourceModules,
      variantModules,
      diff,
      glossary,
      styleGuide,
    });
    const run = await runTranslationProvider(handle, system, user);

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonFence(run.text));
    } catch (e) {
      return err({
        kind: "HandlerError",
        operation: "translation.mode_2",
        message: `provider returned non-JSON: ${(e as Error).message}; first 200 chars: ${run.text.slice(0, 200)}`,
      });
    }
    const validated = translationResultPayload.safeParse(parsed);
    if (!validated.success) {
      return err({
        kind: "HandlerError",
        operation: "translation.mode_2",
        message: `provider returned invalid shape: ${validated.error.issues
          .slice(0, 3)
          .map((i) => i.path.join(".") + ": " + i.message)
          .join("; ")}`,
      });
    }
    const responses = validated.data.modules;

    // Structural lock: every responded module MUST match a `changed`
    // entry in the diff. The AI cannot invent a slot or rewrite a slot
    // it wasn't asked about — that prevents drift to non-aligned
    // translations.
    const changedKeys = new Set(changed.map((c) => `${c.blockName}|${c.position}`));
    for (const r of responses) {
      const key = `${r.blockName}|${r.position}`;
      if (!changedKeys.has(key)) {
        return err({
          kind: "HandlerError",
          operation: "translation.mode_2",
          message: `provider returned module ${key} which was not in the changed-blocks set — refusing to apply (structural lock)`,
        });
      }
    }

    // Apply translations to the variant's modules (UPDATE in place;
    // module rows are already cloned per-locale by Mode 1).
    let actuallyChanged = 0;
    for (const r of responses) {
      const variantSlot = variantModules.find(
        (v) => v.blockName === r.blockName && v.position === r.position,
      );
      if (!variantSlot) continue;
      await tx.execute(sql`
        UPDATE modules SET html = ${r.html}, updated_at = now()
        WHERE id = ${variantSlot.moduleId}::uuid
      `);
      actuallyChanged += 1;
    }

    // Bump translated_from_hash + flip status to up_to_date.
    await tx.execute(sql`
      UPDATE pages
      SET translated_from_hash = ${source.content_hash},
          translation_status = 'up_to_date',
          updated_at = now()
      WHERE id = ${variantPageId}::uuid
    `);

    // Snapshot the variant's layout state so revert works.
    const layoutState = await loadPageLayoutState(tx, variantPageId);
    await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "pages.set_modules",
      description: `translation.mode_2 ${source.slug} → ${input.targetLocale} (${actuallyChanged} blocks)`,
      entities: [{ kind: "pageLayout", entityId: variantPageId, state: layoutState }],
    });
    await recomputePageContentHash(tx, variantPageId);

    const inputCost = handle.inputCostPerMTok ?? DEFAULT_INPUT_COST_PER_M;
    const outputCost = handle.outputCostPerMTok ?? DEFAULT_OUTPUT_COST_PER_M;
    const costUsd =
      ((run.inputTokens - run.cachedTokens) * inputCost + run.outputTokens * outputCost) /
      1_000_000;
    const costMicrocents = microcents(Math.max(0, costUsd));

    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "translation.mode_2",
      input,
      succeeded: true,
      entityId: variantPageId,
      resultSummary: `${source.slug}→${input.targetLocale} changed=${actuallyChanged} added=${blocksAdded} removed=${blocksRemoved} cost_µ¢=${costMicrocents}`,
    });

    return ok({
      variantPageId,
      blocksChanged: actuallyChanged,
      blocksAdded,
      blocksRemoved,
      costMicrocents,
    });
  },
});

// pages.translation_status_matrix already exists from P9 optimization #3.
// We don't re-export it here.

/**
 * compute_diff op — read-only; returns the diff between source and
 * variant for a given (pageId, targetLocale). UI uses it to render
 * "needs update (3 sections changed)" badges without a Mode 2 call.
 */
export const translationDiffOp = defineOperation({
  name: "translation.compute_diff",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      pageId: z.string().uuid(),
      targetLocale: z.string().min(2).max(10),
    })
    .strict(),
  output: z.object({
    variantPageId: z.string().nullable(),
    changed: z.number().int().nonnegative(),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
  }),
  handler: async (_ctx, input, tx) => {
    const sourceRows = (await tx.execute(sql`
      SELECT slug FROM pages WHERE id = ${input.pageId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { slug: string }[];
    const source = sourceRows[0];
    if (!source) {
      return err({
        kind: "HandlerError",
        operation: "translation.compute_diff",
        message: "source page not found",
      });
    }
    const variantRows = (await tx.execute(sql`
      SELECT id::text AS id FROM pages
      WHERE slug = ${source.slug} AND locale = ${input.targetLocale} AND deleted_at IS NULL
      LIMIT 1
    `)) as unknown as { id: string }[];
    const variantPageId = variantRows[0]?.id ?? null;
    if (!variantPageId) {
      return ok({ variantPageId: null, changed: 0, added: 0, removed: 0 });
    }
    const sourceModules = await loadModuleSlots(tx, input.pageId);
    const variantModules = await loadModuleSlots(tx, variantPageId);
    const diff = computeBlockDiff(sourceModules, variantModules);
    return ok({
      variantPageId,
      changed: diff.filter((d) => d.kind === "changed").length,
      added: diff.filter((d) => d.kind === "added").length,
      removed: diff.filter((d) => d.kind === "removed").length,
    });
  },
});
