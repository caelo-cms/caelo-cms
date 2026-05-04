// SPDX-License-Identifier: MPL-2.0

/**
 * P10 — Mode 1: new translation. Source page has no row in the target
 * locale. Clones the source page + its module layout (per CMS_REQUIREMENTS
 * §7.5 — translations are separate page rows with their own cloned
 * modules whose CONTENT differs but POSITION/BLOCK-NAME alignment is
 * locked to the source). Each cloned module's HTML is translated by the
 * AI; alt/caption/etc. live inside the HTML and are translated as part
 * of it (no separate per-locale fields in v1).
 *
 * Lands as draft — never auto-published. The user must confirm via the
 * standard publish flow.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { defineOperation } from "@caelo-cms/query-api";
import {
  buildModeOnePrompt,
  err,
  type GlossaryEntry,
  type ModuleBlockSlot,
  ok,
  translationResultPayload,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AIProvider } from "../../ai/provider.js";
import { recordAudit } from "../../audit.js";
import {
  emitSnapshot,
  loadModuleState,
  loadPageLayoutState,
  loadPageState,
} from "../../snapshots/index.js";
import { recomputePageContentHash } from "../content/content_hash.js";

interface TranslationProviderHandle {
  readonly provider: AIProvider;
  readonly inputCostPerMTok?: number;
  readonly outputCostPerMTok?: number;
}

let injectedProvider: TranslationProviderHandle | null = null;
/**
 * Injected by the SvelteKit hooks layer (single instance per process).
 * Tests override this directly. The op operates against whatever
 * provider the host wires up — same shape as the chat-runner uses.
 */
export function setTranslationProvider(handle: TranslationProviderHandle | null): void {
  injectedProvider = handle;
}

function requireProvider(): TranslationProviderHandle {
  if (!injectedProvider) {
    throw new Error("translation provider not configured — call setTranslationProvider(...)");
  }
  return injectedProvider;
}

const DEFAULT_INPUT_COST_PER_M = 15; // Opus 4.7 input rate, USD per 1M tokens
const DEFAULT_OUTPUT_COST_PER_M = 75;

function microcents(usd: number): number {
  return Math.round(usd * 1e8);
}

interface ProviderRunResult {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
}

/**
 * Run a single completion against the provider, accumulating text +
 * usage. Translations are non-streaming logically (the result is a JSON
 * object), but the provider abstraction streams tokens — we just
 * concatenate. No tools used; the model returns text only.
 */
async function runProvider(
  handle: TranslationProviderHandle,
  systemPrompt: string,
  userPrompt: string,
): Promise<ProviderRunResult> {
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  for await (const event of handle.provider.generate({
    systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    tools: [],
  })) {
    if (event.kind === "text-delta") text += event.text;
    else if (event.kind === "usage") {
      inputTokens += event.inputTokens;
      outputTokens += event.outputTokens;
      cachedTokens += event.cachedTokens;
    } else if (event.kind === "error") {
      throw new Error(`translation provider error: ${event.message}`);
    }
  }
  return { text, inputTokens, outputTokens, cachedTokens };
}

/**
 * Strip Markdown code-fences if the model wrapped its JSON. Anthropic
 * Opus often returns ```json {...} ``` even when asked for raw JSON;
 * accepting both shapes saves a brittle re-prompt.
 */
function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    const firstNl = trimmed.indexOf("\n");
    const last = trimmed.lastIndexOf("```");
    if (firstNl !== -1 && last > firstNl) {
      return trimmed.slice(firstNl + 1, last).trim();
    }
  }
  return trimmed;
}

interface SourcePageRow {
  id: string;
  slug: string;
  locale: string;
  name: string;
  title: string;
  template_id: string;
  status: "draft" | "published";
  content_hash: string | null;
}

async function loadSourceModuleSlots(
  tx: TransactionRunner,
  pageId: string,
): Promise<ModuleBlockSlot[]> {
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

export const translationModeOneOp = defineOperation({
  name: "translation.mode_1",
  // CLAUDE.md §11: AI tool dispatcher calls this; humans invoke via UI.
  // Translation is a content op, not a security op — open to all kinds.
  // The "lands as draft, never published" contract is enforced in the
  // handler (status='draft' on insert), not by actorScope.
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
    moduleCount: z.number().int().nonnegative(),
    costMicrocents: z.number().int().nonnegative(),
  }),
  handler: async (ctx, input, tx) => {
    const handle = requireProvider();
    const startedAt = Date.now();

    // Load source page + verify the target locale exists.
    const sourceRows = (await tx.execute(sql`
      SELECT id::text AS id, slug, locale, name, title, template_id::text AS template_id,
             status, content_hash
      FROM pages WHERE id = ${input.pageId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as SourcePageRow[];
    const source = sourceRows[0];
    if (!source) {
      return err({
        kind: "HandlerError",
        operation: "translation.mode_1",
        message: "source page not found",
      });
    }
    if (source.locale === input.targetLocale) {
      return err({
        kind: "HandlerError",
        operation: "translation.mode_1",
        message: "target locale matches source — nothing to translate",
      });
    }
    const localeRows = (await tx.execute(sql`
      SELECT display_name FROM locales WHERE code = ${input.targetLocale} LIMIT 1
    `)) as unknown as { display_name: string }[];
    if (localeRows.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "translation.mode_1",
        message: `target locale '${input.targetLocale}' not in registry`,
      });
    }
    // No-clobber: if a variant already exists for this (slug, target),
    // Mode 1 refuses. Caller should dispatch Mode 2 instead.
    const dup = (await tx.execute(sql`
      SELECT 1 AS x FROM pages
      WHERE slug = ${source.slug} AND locale = ${input.targetLocale} AND deleted_at IS NULL
      LIMIT 1
    `)) as unknown as { x: number }[];
    if (dup.length > 0) {
      return err({
        kind: "HandlerError",
        operation: "translation.mode_1",
        message: `variant already exists for (slug=${source.slug}, locale=${input.targetLocale}) — use translation.mode_2 to update`,
      });
    }

    const sourceModules = await loadSourceModuleSlots(tx, input.pageId);
    if (sourceModules.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "translation.mode_1",
        message: "source page has no modules to translate",
      });
    }
    const glossary = await loadGlossary(tx, input.targetLocale);
    const styleGuide = await loadStyleGuide(tx, input.targetLocale);

    // Build the prompt + run the provider.
    const { system, user } = buildModeOnePrompt({
      sourceLocale: source.locale,
      targetLocale: input.targetLocale,
      targetLocaleDisplayName: localeRows[0]?.display_name,
      sourceModules,
      glossary,
      styleGuide,
    });
    const run = await runProvider(handle, system, user);

    // Parse + validate the AI response.
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonFence(run.text));
    } catch (e) {
      return err({
        kind: "HandlerError",
        operation: "translation.mode_1",
        message: `provider returned non-JSON: ${(e as Error).message}; first 200 chars: ${run.text.slice(0, 200)}`,
      });
    }
    const validated = translationResultPayload.safeParse(parsed);
    if (!validated.success) {
      return err({
        kind: "HandlerError",
        operation: "translation.mode_1",
        message: `provider returned invalid shape: ${validated.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      });
    }
    const translated = validated.data.modules;

    // Structural lock — every source module must have a matching
    // translated module by (blockName, position), and there must be NO
    // extras. Prevents the AI from inventing a module slot.
    if (translated.length !== sourceModules.length) {
      return err({
        kind: "HandlerError",
        operation: "translation.mode_1",
        message: `provider returned ${translated.length} modules; expected ${sourceModules.length} (one per source module)`,
      });
    }
    const translatedByKey = new Map<string, (typeof translated)[number]>();
    for (const t of translated) translatedByKey.set(`${t.blockName}|${t.position}`, t);
    for (const s of sourceModules) {
      if (!translatedByKey.has(`${s.blockName}|${s.position}`)) {
        return err({
          kind: "HandlerError",
          operation: "translation.mode_1",
          message: `provider response missing module for block=${s.blockName} position=${s.position}`,
        });
      }
    }

    // Create the variant page (draft) — same template, same name/title
    // for now; the AI's translated module HTML carries the visible
    // content. Editor can rename the variant after review if desired.
    const variantRows = (await tx.execute(sql`
      INSERT INTO pages (slug, locale, name, title, template_id, status,
                         translation_status, translated_from_hash)
      VALUES (
        ${source.slug}, ${input.targetLocale}, ${source.name}, ${source.title},
        ${source.template_id}::uuid, 'draft', 'up_to_date', ${source.content_hash}
      )
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const variantPageId = variantRows[0]?.id;
    if (!variantPageId) {
      return err({
        kind: "HandlerError",
        operation: "translation.mode_1",
        message: "variant page insert returned no id",
      });
    }

    // Clone each source module → new module row with translated HTML.
    // Slug suffix `-<locale>` keeps slug uniqueness without colliding
    // with the source. Deletion of the variant page later cascades
    // through page_modules but leaves the cloned modules — Mode 2
    // updates them in place; if the variant is fully deleted, the
    // orphans are cleaned by the existing modules cleanup pass.
    const newModuleIds: string[] = [];
    for (const s of sourceModules) {
      const t = translatedByKey.get(`${s.blockName}|${s.position}`);
      if (!t) continue;
      // Slug uniqueness: append a stable suffix so multiple locales
      // can clone the same source module without conflict.
      const variantSlug = `${s.moduleSlug}--${input.targetLocale}`;
      const inserted = (await tx.execute(sql`
        INSERT INTO modules (slug, display_name, html, css, js)
        SELECT ${variantSlug}, display_name, ${t.html}, css, js
        FROM modules WHERE id = ${s.moduleId}::uuid
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      const newModuleId = inserted[0]?.id;
      if (!newModuleId) {
        return err({
          kind: "HandlerError",
          operation: "translation.mode_1",
          message: `failed to clone source module ${s.moduleId}`,
        });
      }
      newModuleIds.push(newModuleId);
      await tx.execute(sql`
        INSERT INTO page_modules (page_id, block_name, position, module_id)
        VALUES (${variantPageId}::uuid, ${s.blockName}, ${s.position}, ${newModuleId}::uuid)
      `);
    }

    // Snapshot each cloned module so a later Mode 2 revert can restore
    // the Mode 1 baseline translation. Without these the revert path
    // can flip the layout but not the module HTML.
    for (const newModuleId of newModuleIds) {
      const moduleState = await loadModuleState(tx, newModuleId);
      if (moduleState) {
        await emitSnapshot(tx, {
          actorId: ctx.actorId,
          opKind: "modules.create",
          description: `translation.mode_1 ${source.slug} → ${input.targetLocale} module`,
          entities: [{ kind: "module", entityId: newModuleId, state: moduleState }],
        });
      }
    }

    // Snapshot the variant: pages.create + pages.set_modules so the
    // standard revert path works.
    const pageState = await loadPageState(tx, variantPageId);
    if (pageState) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "pages.create",
        description: `translation.mode_1 ${source.slug} → ${input.targetLocale}`,
        entities: [{ kind: "page", entityId: variantPageId, state: pageState }],
      });
    }
    const layoutState = await loadPageLayoutState(tx, variantPageId);
    await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "pages.set_modules",
      description: `translation.mode_1 ${source.slug} → ${input.targetLocale} layout`,
      entities: [{ kind: "pageLayout", entityId: variantPageId, state: layoutState }],
    });
    // P9 — the variant has its own content_hash too (not strictly used
    // for a target-locale row but keeps the column populated).
    await recomputePageContentHash(tx, variantPageId);

    const inputCost = handle.inputCostPerMTok ?? DEFAULT_INPUT_COST_PER_M;
    const outputCost = handle.outputCostPerMTok ?? DEFAULT_OUTPUT_COST_PER_M;
    const costUsd =
      ((run.inputTokens - run.cachedTokens) * inputCost + run.outputTokens * outputCost) /
      1_000_000;
    const costMicrocents = microcents(Math.max(0, costUsd));

    // P10 review pass — write to ai_calls so the cost dashboard (P16)
    // attributes translation spend alongside chat. chat_session_id is
    // null for translation calls (they're not part of a chat).
    await tx.execute(sql`
      INSERT INTO ai_calls (chat_session_id, actor_id, provider, model,
                            input_tokens, output_tokens, cached_tokens,
                            cost_estimate_microcents, duration_ms, succeeded)
      VALUES (
        NULL,
        ${ctx.actorId}::uuid,
        ${handle.provider.name},
        ${handle.provider.model},
        ${run.inputTokens},
        ${run.outputTokens},
        ${run.cachedTokens},
        ${costMicrocents},
        ${Date.now() - startedAt},
        true
      )
    `);

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "translation.mode_1",
      input,
      succeeded: true,
      entityId: variantPageId,
      resultSummary: `${source.slug}→${input.targetLocale} modules=${sourceModules.length} cost_µ¢=${costMicrocents}`,
    });

    return ok({
      variantPageId,
      moduleCount: sourceModules.length,
      costMicrocents,
    });
  },
});

export type { TranslationProviderHandle };
// Re-exports so Mode 2 reuses the provider runner + JSON-fence
// stripper without duplicating them. Same pattern as
// `recomputePageContentHash`.
export { runProvider as runTranslationProvider, stripJsonFence };
