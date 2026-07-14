// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #299 — `pages.build_page`: ONE call assembles a page.
 *
 * Collapses the run-#15 build chain (create_page → N× add_module_to_page
 * → N× create_content_instance / set_page_module_content) into a single
 * transaction: page create (or existing-page target) + N× (module mint
 * or reuse + content_instance mint/bind + placement append).
 *
 * Reuse over reimplementation: the handler delegates to the existing op
 * handlers (`pages.create`, `modules.create`, `content_instances.create`)
 * with the SHARED tx, so every validation rule, audit row and snapshot
 * those paths emit applies here unchanged — all inside one transaction.
 * Snapshot rows therefore group under the same `chat_task_id` exactly
 * like the singular chain, and the final placement write emits one
 * `pages.set_modules`-kind layout snapshot for the whole batch.
 *
 * All-or-nothing (§11): any failure after the first write throws
 * `OperationAbortError` so the adapter rolls the WHOLE call back —
 * partial pages are impossible. Error messages name the failing module
 * index (`modules[3] ("Hero") …`) and, for content-value problems, the
 * failing field (via content_instances' nested-ref validator).
 */

import { defineOperation, OperationAbortError } from "@caelo-cms/query-api";
import {
  type BuildPageContent,
  buildPageInputSchema,
  buildPagePlacementResultSchema,
  contentInstanceCreateSchema,
  err,
  moduleCreateSchema,
  ok,
  pageCreateSchema,
  slugifyModuleSection,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { branchVisibilityFilter } from "../../branch.js";
import { checkAndAcquireEntityLock, entityWriteBlockedError } from "../../locks.js";
import {
  emitSnapshot,
  loadPageLayoutState,
  loadPageLayoutStateWithBranchOverlay,
} from "../../snapshots/index.js";
import { planBuildPagePlacements, type ResolvedBuildPlacement } from "./build-page-plan.js";
import { recomputePageContentHash } from "./content_hash.js";
import { createContentInstanceOp } from "./content-instances.js";
import { createModuleOp } from "./modules.js";
import { createPageOp } from "./pages.js";

/** Human-readable label for error messages: index + best identifier. */
function moduleLabel(index: number, entry: { displayName?: string; moduleId?: string }): string {
  const name = entry.displayName ?? entry.moduleId ?? "?";
  return `modules[${index}] ("${name}")`;
}

/** Structured recovery hint shape (mirrors QueryError.HandlerError.nextAction). */
interface BuildPageNextAction {
  readonly tool: string;
  readonly args?: Record<string, unknown>;
  readonly reason: string;
  readonly autoExecute?: boolean;
  readonly retryWithArgs?: { readonly argName: string; readonly fromValuePath: string };
}

export const buildPageOp = defineOperation({
  name: "pages.build_page",
  // CLAUDE.md §11 — the AI is the primary caller; humans/system may
  // drive the same composite from scripts.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: buildPageInputSchema,
  output: z.object({
    pageId: z.string(),
    /** True when this call created the page (vs targeting an existing one). */
    createdPage: z.boolean(),
    placements: z.array(buildPagePlacementResultSchema),
    /** Extractor-fallback field names per minted module that omitted `fields[]`. */
    extractedFieldsByIndex: z.record(
      z.string(),
      z.array(z.object({ name: z.string(), kind: z.string() })),
    ),
  }),
  handler: async (ctx, input, tx) => {
    // Once anything has been written, failures must THROW so the tx
    // rolls back (see OperationAbortError — `return err` would commit
    // the partial build).
    let wrote = false;
    const fail = (message: string, nextAction?: BuildPageNextAction) => {
      const queryError = {
        kind: "HandlerError" as const,
        operation: "pages.build_page",
        message,
        ...(nextAction ? { nextAction } : {}),
      };
      if (wrote) throw new OperationAbortError(queryError);
      return err(queryError);
    };

    // ── 1. Resolve the target page ─────────────────────────────────
    let pageId: string;
    let createdPage = false;
    let templateId: string;
    let pageSlug: string;
    if (input.page.pageId !== undefined) {
      pageId = input.page.pageId;
      const lock = await checkAndAcquireEntityLock(tx, {
        kind: "page",
        entityId: pageId,
        chatBranchId: ctx.chatBranchId,
        holderKey: ctx.chatTaskId,
      });
      if (!lock.permitted) {
        return err(await entityWriteBlockedError(tx, "pages.build_page", "page", pageId, lock));
      }
      const branchFilter = branchVisibilityFilter(ctx);
      const rows = (await tx.execute(sql`
        SELECT slug, template_id::text AS template_id
        FROM pages
        WHERE id = ${pageId}::uuid AND deleted_at IS NULL ${branchFilter}
        LIMIT 1
      `)) as unknown as { slug: string; template_id: string }[];
      const row = rows[0];
      if (!row) {
        return fail(
          `page ${pageId} not found — pass a pageId from \`## Pages\`, or omit pageId and pass slug + title to create the page in this call`,
        );
      }
      templateId = row.template_id;
      pageSlug = row.slug;
    } else {
      // Create mode — parse through the singular schema so defaults
      // (locale, status) apply exactly as pages.create expects, then
      // delegate to its handler for template resolution + slug checks
      // + snapshot emission.
      const parsed = pageCreateSchema.safeParse({
        slug: input.page.slug,
        title: input.page.title,
        ...(input.page.name !== undefined ? { name: input.page.name } : {}),
        ...(input.page.locale !== undefined ? { locale: input.page.locale } : {}),
        ...(input.page.templateId !== undefined ? { templateId: input.page.templateId } : {}),
        ...(input.page.status !== undefined ? { status: input.page.status } : {}),
      });
      if (!parsed.success) {
        return fail(`page: ${parsed.error.issues[0]?.message ?? "invalid page payload"}`);
      }
      const created = await createPageOp.handler(ctx, parsed.data, tx);
      if (!created.ok) {
        const inner = created.error as { message?: string; nextAction?: BuildPageNextAction };
        // Forward the recovery hint but DROP retryWithArgs — pages.create's
        // declarative retry injects a top-level `templateId` arg, which on
        // build_page lives at `page.templateId` and would be rejected by
        // the strict schema. The AI still gets the list + retries itself.
        const forwarded = inner.nextAction
          ? {
              tool: inner.nextAction.tool,
              reason: `${inner.nextAction.reason} (on build_page, pass it as page.templateId)`,
              ...(inner.nextAction.args ? { args: inner.nextAction.args } : {}),
              ...(inner.nextAction.autoExecute ? { autoExecute: true } : {}),
            }
          : undefined;
        return fail(`page: pages.create failed: ${inner.message ?? created.error.kind}`, forwarded);
      }
      pageId = (created.value as { pageId: string }).pageId;
      createdPage = true;
      wrote = true;
      pageSlug = parsed.data.slug;
      const tplRows = (await tx.execute(sql`
        SELECT template_id::text AS template_id FROM pages WHERE id = ${pageId}::uuid LIMIT 1
      `)) as unknown as { template_id: string }[];
      const resolvedTpl = tplRows[0]?.template_id;
      if (!resolvedTpl) {
        return fail("page: created page row has no template_id (unexpected)");
      }
      templateId = resolvedTpl;
    }

    // ── 2. Validate every blockName against the template up front ──
    // One read, all indices checked, so a typo'd block on modules[7]
    // fails BEFORE seven modules are minted (still rolled back either
    // way, but the error arrives without burning the work).
    const blockRows = (await tx.execute(sql`
      SELECT name FROM template_blocks WHERE template_id = ${templateId}::uuid ORDER BY position ASC
    `)) as unknown as { name: string }[];
    const allowedBlocks = new Set(blockRows.map((r) => r.name));
    for (const [i, entry] of input.modules.entries()) {
      if (!allowedBlocks.has(entry.blockName)) {
        return fail(
          `${moduleLabel(i, entry)}: block "${entry.blockName}" does not exist on this page's template. ` +
            `Available blocks: ${[...allowedBlocks].join(", ")}`,
        );
      }
    }

    // ── 3. Per module: resolve module + content_instance ───────────
    const additions: ResolvedBuildPlacement[] = [];
    const mintedFlags: boolean[] = [];
    const extractedFieldsByIndex: Record<string, { name: string; kind: string }[]> = {};
    for (const [i, entry] of input.modules.entries()) {
      let moduleId: string;
      let minted = false;
      if (entry.moduleId !== undefined) {
        // Place mode — branch-aware existence check (a module minted
        // earlier in this same chat must be placeable).
        const branchFilter = branchVisibilityFilter(ctx);
        const rows = (await tx.execute(sql`
          SELECT id::text AS id FROM modules
          WHERE id = ${entry.moduleId}::uuid AND deleted_at IS NULL ${branchFilter}
          LIMIT 1
        `)) as unknown as { id: string }[];
        if (!rows[0]) {
          return fail(
            `${moduleLabel(i, entry)}: module ${entry.moduleId} not found or deleted — ` +
              "pass an id from `## Modules` / list_modules, or author displayName + html to mint a new module",
          );
        }
        moduleId = entry.moduleId;
      } else {
        // Mint mode. The Zod superRefine enforces displayName+html at
        // the dispatch boundary; re-narrow for direct handler calls
        // (tests, future reuse) — same pattern as add_module_to_page.
        const { displayName, html } = entry;
        if (displayName === undefined || html === undefined) {
          return fail(
            `${moduleLabel(i, entry)}: pass either \`moduleId\` (place an existing module) or \`displayName\` + \`html\` (mint a new one)`,
          );
        }
        // Run the singular schema so defaults apply, then delegate to
        // modules.create (extractor fallback, type derivation, slug-dup
        // check, media usage, snapshot). slugifyModuleSection includes
        // the index so two same-named entries in one batch can't
        // collide on the slug.
        const parsed = moduleCreateSchema.safeParse({
          slug: slugifyModuleSection(displayName, i),
          displayName,
          html,
          ...(entry.description !== undefined ? { description: entry.description } : {}),
          ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
          ...(entry.type !== undefined ? { type: entry.type } : {}),
          ...(entry.css !== undefined ? { css: entry.css } : {}),
          ...(entry.js !== undefined ? { js: entry.js } : {}),
          ...(entry.fields !== undefined ? { fields: entry.fields } : {}),
        });
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const at = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
          return fail(
            `${moduleLabel(i, entry)}${at}: ${issue?.message ?? "invalid module payload"}`,
          );
        }
        const created = await createModuleOp.handler(ctx, parsed.data, tx);
        if (!created.ok) {
          const inner = created.error as { message?: string };
          return fail(
            `${moduleLabel(i, entry)}: modules.create failed: ${inner.message ?? created.error.kind}`,
          );
        }
        wrote = true;
        minted = true;
        moduleId = (created.value as { moduleId: string }).moduleId;
        const extracted = (created.value as { extractedFields?: { name: string; kind: string }[] })
          .extractedFields;
        if (extracted && extracted.length > 0) {
          extractedFieldsByIndex[String(i)] = extracted.map((f) => ({
            name: f.name,
            kind: f.kind,
          }));
        }
      }

      // Content resolution — every placement binds a content_instance
      // (page_modules.content_instance_id is NOT NULL).
      const content: BuildPageContent = entry.content ?? { source: "inline", values: {} };
      let contentInstanceId: string;
      let syncMode: "synced" | "unsynced";
      if (content.source === "existing") {
        const branchFilter = branchVisibilityFilter(ctx);
        const ciRows = (await tx.execute(sql`
          SELECT module_id::text AS module_id FROM content_instances
          WHERE id = ${content.contentInstanceId}::uuid AND deleted_at IS NULL ${branchFilter}
          LIMIT 1
        `)) as unknown as { module_id: string }[];
        const ci = ciRows[0];
        if (!ci) {
          return fail(
            `${moduleLabel(i, entry)}: content_instance ${content.contentInstanceId} not found or deleted — ` +
              "pick one from `## Content Library` / list_content_instances, or pass content.source='inline' with values instead",
          );
        }
        if (ci.module_id !== moduleId) {
          return fail(
            `${moduleLabel(i, entry)}: content_instance ${content.contentInstanceId} is for module ${ci.module_id}, ` +
              `but this placement uses module ${moduleId}. Bind a content_instance minted for the same module.`,
          );
        }
        contentInstanceId = content.contentInstanceId;
        syncMode = content.syncMode;
      } else {
        // inline → private unsynced row; shared → reusable row with
        // purpose + (default) synced binding. Both delegate to
        // content_instances.create so nested-ref + field-shape
        // validation runs and names the offending FIELD in its error.
        const ciInput = contentInstanceCreateSchema.safeParse(
          content.source === "inline"
            ? { moduleId, values: content.values }
            : {
                moduleId,
                values: content.values,
                purpose: content.purpose,
                ...(content.slug !== undefined ? { slug: content.slug } : {}),
                ...(content.displayName !== undefined ? { displayName: content.displayName } : {}),
              },
        );
        if (!ciInput.success) {
          const issue = ciInput.error.issues[0];
          const at = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
          return fail(
            `${moduleLabel(i, entry)}: content${at}: ${issue?.message ?? "invalid content payload"}`,
          );
        }
        const ciCreated = await createContentInstanceOp.handler(ctx, ciInput.data, tx);
        if (!ciCreated.ok) {
          const inner = ciCreated.error as { message?: string };
          // content_instances.create's validator names the failing
          // field ("field \"hero_title\" (kind=number) expects …") —
          // forward it verbatim under the module index.
          return fail(
            `${moduleLabel(i, entry)}: content: ${inner.message ?? ciCreated.error.kind}`,
          );
        }
        wrote = true;
        contentInstanceId = (ciCreated.value as { contentInstanceId: string }).contentInstanceId;
        syncMode = content.source === "shared" ? content.syncMode : "unsynced";
      }

      additions.push({ blockName: entry.blockName, moduleId, contentInstanceId, syncMode });
      mintedFlags.push(minted);
    }

    // ── 4. Placements — merge into the current layout, one write ───
    // Base layout is branch-overlay-aware so a build onto a page this
    // chat already touched composes with its earlier branched edits.
    const base = await loadPageLayoutStateWithBranchOverlay(tx, pageId, ctx.chatBranchId ?? null);
    const plan = planBuildPagePlacements(base, additions);

    const branched = !!ctx.chatBranchId;
    let layoutState = plan.nextLayout;
    if (!branched) {
      await tx.execute(sql`DELETE FROM page_modules WHERE page_id = ${pageId}::uuid`);
      for (const block of plan.nextLayout.blocks) {
        const placements = block.placements ?? [];
        for (const [pos, p] of placements.entries()) {
          await tx.execute(sql`
            INSERT INTO page_modules
              (page_id, block_name, position, module_id, content_instance_id, sync_mode)
            VALUES (
              ${pageId}::uuid,
              ${block.blockName},
              ${pos},
              ${p.moduleId}::uuid,
              ${p.contentInstanceId}::uuid,
              ${p.syncMode}
            )
          `);
        }
      }
      await tx.execute(sql`
        UPDATE pages SET updated_at = now(), version = version + 1
        WHERE id = ${pageId}::uuid
      `);
      layoutState = await loadPageLayoutState(tx, pageId);
    }
    wrote = true;

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "pages.build_page",
      input,
      succeeded: true,
      entityId: pageId,
      resultSummary: `slug=${pageSlug} created=${createdPage} modules=${input.modules.length} minted=${mintedFlags.filter(Boolean).length}${branched ? " (branched)" : ""}`,
    });
    // One layout snapshot for the whole batch. opKind reuses
    // pages.set_modules (the site_snapshots CHECK constraint's closed
    // set — a dedicated kind would need its own migration for zero
    // revert benefit; revert applies the layout state either way).
    await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "pages.set_modules",
      description: `pages.build_page slug=${pageSlug} modules=${input.modules.length}${branched ? " (branched)" : ""}`,
      chatTaskId: ctx.chatTaskId ?? null,
      chatBranchId: ctx.chatBranchId ?? null,
      entities: [{ kind: "pageLayout", entityId: pageId, state: layoutState }],
    });
    if (!branched) {
      await recomputePageContentHash(tx, pageId);
    }

    return ok({
      pageId,
      createdPage,
      placements: plan.appended.map((p, i) => ({
        blockName: p.blockName,
        position: p.position,
        moduleId: p.moduleId,
        contentInstanceId: p.contentInstanceId,
        syncMode: p.syncMode,
        minted: mintedFlags[i] ?? false,
      })),
      extractedFieldsByIndex,
    });
  },
});
