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
 * partial pages are impossible.
 *
 * Errors (#1277): every check that needs no write runs before the first
 * write and ALL its problems come back in one result (page envelope,
 * unknown ids, refs, module + content shapes, blocks when the template is
 * known), each at its absolute input path (`modules[3].content.values.
 * hero_title`) in `errors[]`. After the writes start, every entry still
 * runs: each failing entry adds its problems, and entries embedding a
 * failed entry are skipped. A nested op that THROWS a driver error is
 * caught per entry and reported under `modules[i]` (no SQLSTATE); since
 * Postgres aborted the transaction, the call stops there.
 */

import {
  defineOperation,
  type ErrorDetail,
  type ErrorPathSegment,
  errorDetailsOf,
  failureKindOf,
  handlerErrorFromDetails,
  internalError,
  OperationAbortError,
  prefixErrorDetails,
  type QueryError,
  thrownToQueryError,
  zodIssuesToErrorDetails,
} from "@caelo-cms/query-api";
import {
  type BuildPageContent,
  type BuildPageInput,
  buildPageInputSchema,
  buildPagePlacementResultSchema,
  contentInstanceCreateSchema,
  err,
  moduleCreateSchema,
  ok,
  pageCreateSchema,
  type Result,
  slugifyModuleSection,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { branchVisibilityFilter } from "../../branch.js";
import { resolvePageTypeForWrite } from "../../lists/page-type-resolve.js";
import { checkAndAcquireEntityLock, entityWriteBlockedError } from "../../locks.js";
import { pageSeoViewSql } from "../../seo/page-seo.js";
import {
  emitSnapshot,
  loadPageLayoutState,
  loadPageLayoutStateWithBranchOverlay,
} from "../../snapshots/index.js";
import { pagesSeoAutofillOp } from "../seo.js";
import {
  orderBuildEntries,
  planBuildPagePlacements,
  type ResolvedBuildPlacement,
} from "./build-page-plan.js";
import { createContentInstanceOp } from "./content-instances.js";
import { createModuleOp } from "./modules.js";
import { createPageOp } from "./pages.js";

/** Human-readable label for error messages: index + best identifier. */
type BuildPageModuleEntry = BuildPageInput["modules"][number];

/**
 * True when mint entry `entry` repeats `earlier` — the same html, and every
 * other authoring field either omitted or equal — so it is a second placement
 * of the same module, not a new one. The model writes three feature cards as
 * three entries with one card's markup, declaring `fields` (and css) on the
 * first only; minting each separately failed the later ones on their
 * undeclared placeholders (e2e-livedit run 40025014982), and three minted
 * copies would be the repeated markup CLAUDE.md §1A makes one module anyway.
 * Placing the first entry's module again is what `moduleId: {"$ref"}` says
 * explicitly. Anything that differs keeps the entry a separate mint.
 */
export function repeatsMint(entry: BuildPageModuleEntry, earlier: BuildPageModuleEntry): boolean {
  if (entry.html === undefined || entry.html !== earlier.html) return false;
  if (entry.displayName !== earlier.displayName) return false;
  const keys = ["description", "kind", "type", "css", "js", "fields", "bindThemeLiterals"] as const;
  return keys.every(
    (k) => entry[k] === undefined || JSON.stringify(entry[k]) === JSON.stringify(earlier[k]),
  );
}

/**
 * Skips an entry whose `{"$ref"}` names an entry that failed: the failure
 * is already reported, and the dependent entry has nothing of its own.
 */
class SkipEntry extends Error {}

/** A nested op THREW (not returned) a driver error; carries the original. */
class NestedThrow extends Error {
  readonly thrown: unknown;
  constructor(thrown: unknown) {
    super("nested operation threw");
    this.thrown = thrown;
  }
}

/**
 * Run a nested op handler so every failure is a Result: a returned error
 * as is, an `OperationAbortError` as its error (the transaction is still
 * usable, so the remaining entries are still checked), any other throw as
 * {@link NestedThrow} (Postgres aborted the transaction; nothing can run
 * after it).
 */
async function runNested<T>(
  fn: () => Promise<Result<T, QueryError>>,
): Promise<Result<T, QueryError>> {
  try {
    return await fn();
  } catch (thrown) {
    if (thrown instanceof OperationAbortError) return { ok: false, error: thrown.queryError };
    throw new NestedThrow(thrown);
  }
}

/** A nested error's text without its kind boilerplate. */
function describeNested(error: QueryError): string {
  if ("message" in error && typeof error.message === "string") return error.message;
  if (error.kind === "RLSDenied") return error.detail;
  return error.kind;
}

/** A placed module's stored metadata (compared against an entry's authoring fields). */
interface PlacedModuleRow {
  id: string;
  display_name: string;
  description: string;
  kind: string;
  type: string | null;
}

/** The `modules.create` input for a mint entry (slug from name + index). */
function mintInput(
  entry: BuildPageModuleEntry,
  displayName: string,
  html: string,
  index: number,
): Record<string, unknown> {
  // slugifyModuleSection includes the index so two same-named entries in
  // one batch can't collide on the slug.
  return {
    slug: slugifyModuleSection(displayName, index),
    displayName,
    html,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
    ...(entry.type !== undefined ? { type: entry.type } : {}),
    ...(entry.css !== undefined ? { css: entry.css } : {}),
    ...(entry.js !== undefined ? { js: entry.js } : {}),
    ...(entry.fields !== undefined ? { fields: entry.fields } : {}),
  };
}

/** Stand-in module id for the shape-only content check before the mint. */
const PLACEHOLDER_MODULE_ID = "00000000-0000-4000-8000-000000000000";

/** The `content_instances.create` input for an inline / shared content entry. */
function contentCreateInput(
  content: Exclude<BuildPageContent, { source: "existing" }>,
  moduleId: string,
): Record<string, unknown> {
  return content.source === "inline"
    ? { moduleId, values: content.values }
    : {
        moduleId,
        values: content.values,
        purpose: content.purpose,
        ...(content.slug !== undefined ? { slug: content.slug } : {}),
        ...(content.displayName !== undefined ? { displayName: content.displayName } : {}),
      };
}

/**
 * §2 — the authoring fields of a placement-only entry that are NOT
 * applied: metadata that differs from the stored module, and every
 * structural field (placement can never re-author a shared module).
 */
function ignoredAuthoring(entry: BuildPageModuleEntry, mod: PlacedModuleRow): string[] {
  const ignored: string[] = [];
  if (entry.displayName !== undefined && entry.displayName !== mod.display_name) {
    ignored.push(`displayName='${entry.displayName}' (module keeps '${mod.display_name}')`);
  }
  if (entry.description !== undefined && entry.description !== mod.description) {
    ignored.push("description");
  }
  if (entry.kind !== undefined && entry.kind !== mod.kind) {
    ignored.push(`kind='${entry.kind}' (module keeps '${mod.kind}')`);
  }
  if (entry.type !== undefined && entry.type !== (mod.type ?? undefined)) {
    ignored.push(`type='${entry.type}' (module keeps '${mod.type ?? "(none)"}')`);
  }
  for (const k of ["html", "css", "js", "fields"] as const) {
    if (entry[k] !== undefined) ignored.push(`${k} (structural)`);
  }
  if (entry.bindThemeLiterals !== undefined) ignored.push("bindThemeLiterals");
  return ignored;
}

/** Layout-level chrome block names a page template never has (see checkBlocks). */
const CHROME_BLOCKS = new Set(["header", "footer", "nav", "navigation", "sidebar", "banner"]);

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
  readScope: "request",
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
    /** Detached (nested-only) entries: minted + content-bound, not placed. */
    detached: z.array(
      z.object({
        /** The entry's index in the call's `modules` array. */
        index: z.number().int().nonnegative(),
        ref: z.string(),
        moduleId: z.string(),
        contentInstanceId: z.string(),
      }),
    ),
    /** Extractor-fallback field names per minted module that omitted `fields[]`. */
    extractedFieldsByIndex: z.record(
      z.string(),
      z.array(z.object({ name: z.string(), kind: z.string() })),
    ),
    /** §2 — per placement-only entry index, authoring fields it carried that
     *  were NOT applied (differing metadata or any structural field). Surfaced
     *  so a change the AI intended never vanishes silently. */
    ignoredAuthoringByIndex: z.record(z.string(), z.array(z.string())),
    /** Per entry index that repeated an earlier mint entry of this call
     *  (same html, nothing conflicting): the index whose module it placed
     *  again instead of minting a copy. See `repeatsMint`. */
    reusedMintByIndex: z.record(z.string(), z.number().int()),
    /**
     * What `page.metaDescription` did: `written` (first fill), `unchanged`
     * (already filled with the same text), `kept-existing` (an import
     * rebuild onto a page that already has one — fill-once, never
     * overwritten), null when none was passed.
     */
    metaDescription: z.enum(["written", "unchanged", "kept-existing"]).nullable(),
  }),
  handler: async (ctx, input, tx) => {
    // Once anything has been written, failures must THROW so the tx
    // rolls back (see OperationAbortError — `return err` would commit
    // the partial build).
    let wrote = false;
    // #1277 — every problem found before the next write is collected and
    // reported in one result, each at its absolute input path.
    const problems: ErrorDetail[] = [];
    let problemRefusal = false;
    let problemInternal = false;
    let problemNextAction: BuildPageNextAction | undefined;
    const problem = (
      path: ErrorPathSegment[],
      message: string,
      extra: { next?: string; allowed?: readonly string[] } = {},
    ) => {
      problems.push({ path, message, ...extra });
    };
    /** A nested op's error under `prefix`: its own paths, or one entry at `prefix`. */
    const nestedProblem = (prefix: ErrorPathSegment[], error: QueryError, label: string) => {
      const details = errorDetailsOf(error);
      if (details.length > 0) problems.push(...prefixErrorDetails(prefix, details));
      else problem(prefix, `${label}: ${describeNested(error)}`);
      if (error.kind === "HandlerError" && error.refusal) problemRefusal = true;
      if (failureKindOf(error) === "internal") problemInternal = true;
    };
    /** Fail with every collected problem (throws once something was written). */
    const failProblems = () => {
      const queryError = handlerErrorFromDetails("pages.build_page", problems, {
        refusal: problemRefusal,
        internal: problemInternal,
      });
      const withNext = problemNextAction
        ? { ...queryError, nextAction: problemNextAction }
        : queryError;
      if (wrote) throw new OperationAbortError(withNext);
      return err(withNext);
    };

    // Minting order: an entry after every entry its {"$ref"} names (any
    // array position). Checked before the first write, so an unknown
    // handle or a cycle costs nothing.
    const ordering = orderBuildEntries(input.modules);
    if (!ordering.ok) {
      for (const issue of ordering.issues) {
        problem(issue.index >= 0 ? ["modules", issue.index] : ["modules"], issue.message);
      }
    }

    // ── 0. Import linkage + idempotency ─────────────────────────────
    // issue #278 flow: `importPageId` links the built page to the
    // `import_pages` row it rebuilds. Two effects:
    //  1. IDEMPOTENCY — if that row already points at a LIVE page
    //     (`accepted_page_id`), this is a REBUILD: target that page
    //     instead of minting a duplicate, so a second build for the same
    //     import page can never create a second page (the run-observed
    //     "homepage built twice" class).
    //  2. LINKAGE — after the build we stamp `accepted_page_id` with the
    //     final page id, so `imports.check_page_inventory` /
    //     `imports.migrate_media` (which both PREFER the pointer over
    //     slug-matching) resolve regardless of the built page's slug —
    //     fixing the slug-coupling misses (incl. the "inventory reports
    //     100% missing" bug, item 4b).
    const importPageId = input.page.importPageId;
    let rebuildTargetPageId: string | undefined;
    if (importPageId !== undefined) {
      const linkRows = (await tx.execute(sql`
        SELECT ip.id::text AS import_id, p.id::text AS live_page_id
        FROM import_pages ip
        LEFT JOIN pages p ON p.id = ip.accepted_page_id AND p.deleted_at IS NULL
        WHERE ip.id = ${importPageId}::uuid
        LIMIT 1
      `)) as unknown as { import_id: string; live_page_id: string | null }[];
      const link = linkRows[0];
      if (!link) {
        problem(["page", "importPageId"], `import page ${importPageId} not found`, {
          next: "Pass an import_pages id from list_import_pages({runId}), or omit importPageId to build a standalone page.",
        });
      } else {
        rebuildTargetPageId = link.live_page_id ?? undefined;
      }
    }

    // ── 1. Resolve the target page (read-only checks first) ─────────
    // An explicit `pageId` always wins; otherwise a prior import linkage
    // (rebuildTargetPageId) turns this into an in-place rebuild.
    let pageId = "";
    let createdPage = false;
    let templateId: string | undefined;
    /** Create mode: the template the page type resolves to (#1276). */
    let typeTemplateId: string | undefined;
    let pageSlug = "";
    const existingTargetId = input.page.pageId ?? rebuildTargetPageId;
    let pageCreateInput: z.infer<typeof pageCreateSchema> | undefined;
    if (existingTargetId !== undefined) {
      pageId = existingTargetId;
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
        problem(["page", "pageId"], `page ${pageId} not found`, {
          next: "Pass a pageId from list_pages, or omit pageId and pass slug + title to create the page in this call.",
        });
      } else {
        templateId = row.template_id;
        pageSlug = row.slug;
      }
    } else {
      // Create mode — parse through the singular schema so defaults
      // (status) applies exactly as pages.create expects; the create
      // itself waits until every read-only check has run.
      const parsed = pageCreateSchema.safeParse({
        slug: input.page.slug,
        title: input.page.title,
        ...(input.page.shortTitle !== undefined ? { shortTitle: input.page.shortTitle } : {}),
        ...(input.page.templateId !== undefined ? { templateId: input.page.templateId } : {}),
        ...(input.page.status !== undefined ? { status: input.page.status } : {}),
        ...(input.page.parentPageId !== undefined ? { parentPageId: input.page.parentPageId } : {}),
        ...(input.page.pageType !== undefined ? { pageType: input.page.pageType } : {}),
        ...(input.page.properties !== undefined ? { properties: input.page.properties } : {}),
        ...(input.page.terms !== undefined ? { terms: input.page.terms } : {}),
      });
      if (!parsed.success) {
        problems.push(...zodIssuesToErrorDetails(parsed.error.issues, ["page"]));
      } else {
        pageCreateInput = parsed.data;
        pageSlug = parsed.data.slug;
        // #1276 — the page type is a read-only check too: a missing or
        // unknown type is reported with the other problems, before the
        // first write (pages.create resolves it again when it runs).
        const resolved = await resolvePageTypeForWrite(tx, ctx.chatBranchId ?? null, {
          ...(parsed.data.pageType !== undefined ? { pageType: parsed.data.pageType } : {}),
          ...(parsed.data.templateId !== undefined ? { templateId: parsed.data.templateId } : {}),
        });
        if (resolved.ok) typeTemplateId = resolved.templateId;
        else problems.push(...prefixErrorDetails(["page"], [resolved.detail]));
      }
    }

    // ── 2. Per entry: every check that needs no write ───────────────
    // (Unknown or self {"$ref"} handles were reported by the ordering check.)
    const placedModules = new Map<number, PlacedModuleRow>();
    for (const [i, entry] of input.modules.entries()) {
      const at: ErrorPathSegment[] = ["modules", i];
      if (typeof entry.moduleId === "string") {
        const branchFilter = branchVisibilityFilter(ctx);
        const rows = (await tx.execute(sql`
          SELECT id::text AS id, display_name, description, kind, type FROM modules
          WHERE id = ${entry.moduleId}::uuid AND deleted_at IS NULL ${branchFilter}
          LIMIT 1
        `)) as unknown as PlacedModuleRow[];
        const mod = rows[0];
        if (!mod) {
          problem([...at, "moduleId"], `module ${entry.moduleId} not found or deleted`, {
            next: "Pass an id from list_modules, or omit moduleId and author displayName + html to mint a new module.",
          });
        } else {
          placedModules.set(i, mod);
        }
      } else if (entry.moduleId === undefined) {
        if (entry.displayName === undefined || entry.html === undefined) {
          problem(
            at,
            "pass either `moduleId` (place an existing module) or `displayName` + `html` (mint a new one)",
          );
        } else {
          const parsed = moduleCreateSchema.safeParse(
            mintInput(entry, entry.displayName, entry.html, i),
          );
          if (!parsed.success) {
            // `slug` is derived from displayName — report it there.
            problems.push(
              ...zodIssuesToErrorDetails(parsed.error.issues).map((d) => ({
                ...d,
                path: [...at, ...(d.path[0] === "slug" ? ["displayName"] : d.path)],
              })),
            );
          }
        }
      }
      const content = entry.content;
      if (content === undefined) continue;
      if (content.source === "existing") {
        const branchFilter = branchVisibilityFilter(ctx);
        const ciRows = (await tx.execute(sql`
          SELECT module_id::text AS module_id,
                 (SELECT slug FROM modules m WHERE m.id = content_instances.module_id) AS module_slug
          FROM content_instances
          WHERE id = ${content.contentInstanceId}::uuid AND deleted_at IS NULL ${branchFilter}
          LIMIT 1
        `)) as unknown as { module_id: string; module_slug: string | null }[];
        const ci = ciRows[0];
        const placed = placedModules.get(i);
        if (!ci) {
          problem(
            [...at, "content", "contentInstanceId"],
            `content_instance ${content.contentInstanceId} not found or deleted`,
            {
              next: "Pick one from list_content_instances, or pass content.source='inline' with values instead.",
            },
          );
        } else if (entry.moduleId === undefined) {
          problem(
            [...at, "content", "contentInstanceId"],
            `content_instance ${content.contentInstanceId} belongs to module "${ci.module_slug}", not to the module this entry mints`,
            { next: "Bind it with that module's id as moduleId, or pass content.source='inline'." },
          );
        } else if (typeof entry.moduleId !== "string") {
          // {"$ref"}: the module of the entry that carries that handle. An
          // existing module placed there owns instances; one minted in this
          // call has none yet.
          const handle = entry.moduleId.$ref;
          const target = input.modules.find((m) => m.ref === handle);
          const targetId = typeof target?.moduleId === "string" ? target.moduleId : undefined;
          if (target && targetId === undefined) {
            problem(
              [...at, "content", "contentInstanceId"],
              `the module "${handle}" is minted in this call, so it has no content instances yet — content_instance ${content.contentInstanceId} belongs to module "${ci.module_slug}"`,
              { next: "Pass content.source='inline' with values for this placement." },
            );
          } else if (targetId !== undefined && ci.module_id !== targetId) {
            problem(
              [...at, "content", "contentInstanceId"],
              `content_instance ${content.contentInstanceId} belongs to module "${ci.module_slug}", not to the module "${handle}" places`,
              { next: "Bind a content_instance of the same module (list_content_instances)." },
            );
          }
        } else if (placed && ci.module_id !== placed.id) {
          problem(
            [...at, "content", "contentInstanceId"],
            `content_instance ${content.contentInstanceId} belongs to module "${ci.module_slug}", but this entry places "${placed.display_name}"`,
            { next: "Bind a content_instance of the same module (list_content_instances)." },
          );
        }
      } else {
        // Shape only (the module id is not known before the mint); the
        // field-by-field value check runs in content_instances.create.
        const ciInput = contentInstanceCreateSchema.safeParse(
          contentCreateInput(content, PLACEHOLDER_MODULE_ID),
        );
        if (!ciInput.success) {
          problems.push(
            ...zodIssuesToErrorDetails(ciInput.error.issues, [...at, "content"]).filter(
              (d) => d.path[3] !== "moduleId",
            ),
          );
        }
      }
    }

    // ── 3. Blocks — known now unless the page is still to be created ─
    // Well-known layout-level chrome. When the rejected block is one of
    // these, the model conflated a LAYOUT block (header/footer/nav, seen
    // in list_layouts as `header|content|footer`) with a PAGE-template
    // block — build_page places into template blocks only. Route it to
    // the fix instead of a bare "Available blocks" list, or the model
    // re-tries the same call until max_loops (live-edit run B5).
    const checkBlocks = async (forTemplateId: string) => {
      const blockRows = (await tx.execute(sql`
        SELECT name FROM template_blocks WHERE template_id = ${forTemplateId}::uuid ORDER BY position ASC
      `)) as unknown as { name: string }[];
      const allowedBlocks = blockRows.map((r) => r.name);
      for (const [i, entry] of input.modules.entries()) {
        // Detached entries (no blockName) skip placement — nothing to check.
        if (entry.blockName === undefined || allowedBlocks.includes(entry.blockName)) continue;
        const chrome = CHROME_BLOCKS.has(entry.blockName.toLowerCase());
        problem(
          ["modules", i, "blockName"],
          `block "${entry.blockName}" does not exist on this page's template`,
          {
            allowed: allowedBlocks,
            ...(chrome
              ? {
                  next:
                    `"${entry.blockName}" is site-wide LAYOUT chrome, not a page block — build_page places into page-template blocks only. ` +
                    `Place it once on the layout instead: add_module({target:'layout', targetRef:'<layout-slug>', blockName:'${entry.blockName.toLowerCase()}', …}) (find the slug via list_layouts), and drop this entry from build_page.`,
                }
              : {}),
          },
        );
      }
    };
    const knownTemplateId = templateId ?? pageCreateInput?.templateId ?? typeTemplateId;
    if (knownTemplateId !== undefined) await checkBlocks(knownTemplateId);
    if (problems.length > 0 || !ordering.ok) return failProblems();

    // ── 4. Create the page (first write) ───────────────────────────
    if (pageCreateInput !== undefined) {
      // Delegate to pages.create for template resolution + slug checks
      // + snapshot emission.
      const created = await createPageOp.handler(ctx, pageCreateInput, tx);
      if (!created.ok) {
        const inner = created.error as { nextAction?: BuildPageNextAction };
        // Forward the recovery hint but DROP retryWithArgs — pages.create's
        // declarative retry injects a top-level `templateId` arg, which on
        // build_page lives at `page.templateId` and would be rejected by
        // the strict schema. The AI still gets the list + retries itself.
        if (inner.nextAction) {
          problemNextAction = {
            tool: inner.nextAction.tool,
            reason: `${inner.nextAction.reason} (on build_page, pass it as page.templateId)`,
            ...(inner.nextAction.args ? { args: inner.nextAction.args } : {}),
            ...(inner.nextAction.autoExecute ? { autoExecute: true } : {}),
          };
        }
        nestedProblem(["page"], created.error, "pages.create failed");
        return failProblems();
      }
      pageId = (created.value as { pageId: string }).pageId;
      createdPage = true;
      wrote = true;
      const tplRows = (await tx.execute(sql`
        SELECT template_id::text AS template_id FROM pages WHERE id = ${pageId}::uuid LIMIT 1
      `)) as unknown as { template_id: string }[];
      const resolvedTpl = tplRows[0]?.template_id;
      if (!resolvedTpl) {
        throw new OperationAbortError(
          internalError("pages.build_page", "the created page row has no template_id"),
        );
      }
      templateId = resolvedTpl;
      if (knownTemplateId === undefined) {
        await checkBlocks(templateId);
        if (problems.length > 0) return failProblems();
      }
    }

    // ── 5. Per module: resolve module + content_instance ───────────
    // Per input index — entries are minted in dependency order but placed
    // (and reported) in array order.
    const additionByIndex = new Map<number, ResolvedBuildPlacement>();
    const mintedByIndex = new Map<number, boolean>();
    const extractedFieldsByIndex: Record<string, { name: string; kind: string }[]> = {};
    // §2 (no silent drop) — a placement-only `moduleId` entry that ALSO carried
    // authoring fields does NOT re-author the shared module; per index we record
    // any such field whose value DIFFERS from the module's stored one, so the
    // tool can tell the AI its change wasn't applied (use update_modules_many) instead
    // of vanishing it.
    const ignoredAuthoringByIndex: Record<string, string[]> = {};
    // Mint entries by their exact html, so a later entry that repeats one
    // places the same module again (see `repeatsMint`).
    const mintedByHtml = new Map<string, { index: number; moduleId: string }>();
    const reusedMintByIndex: Record<string, number> = {};
    // Local `ref` handles → the ids this call minted for them. Later
    // entries embed a nested module by writing {"$ref": "<ref>"} in a
    // module / module-list field value; resolution replaces it with the
    // real {moduleId, contentInstanceId} BEFORE content validation.
    // Entries are minted in `ordering.order` (referenced entries first,
    // whatever their array position), which keeps resolution single-pass
    // and deterministic.
    const localRefs = new Map<string, { moduleId: string; contentInstanceId: string }>();
    // Handles of entries that failed: entries embedding them are skipped
    // (their only problem is the failure already reported).
    const failedRefs = new Set<string>();
    const detached: { index: number; ref: string; moduleId: string; contentInstanceId: string }[] =
      [];
    const resolveLocalRefs = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map((v) => resolveLocalRefs(v));
      if (value !== null && typeof value === "object") {
        const keys = Object.keys(value as Record<string, unknown>);
        if (keys.length === 1 && keys[0] === "$ref") {
          const handle = (value as { $ref: unknown }).$ref;
          const resolved = typeof handle === "string" ? localRefs.get(handle) : undefined;
          // The ordering check guarantees the handle exists and was minted
          // first; only a failed entry leaves it unresolved.
          if (!resolved) throw new SkipEntry();
          return resolved;
        }
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([k, v]) => [
            k,
            resolveLocalRefs(v),
          ]),
        );
      }
      return value;
    };
    const failEntry = (entry: BuildPageModuleEntry) => {
      if (entry.ref !== undefined) failedRefs.add(entry.ref);
    };
    for (const i of ordering.order) {
      const entry = input.modules[i] as BuildPageModuleEntry;
      const at: ErrorPathSegment[] = ["modules", i];
      let moduleId: string;
      let minted = false;
      try {
        if (entry.moduleId !== undefined && typeof entry.moduleId !== "string") {
          // Place mode via local ref: re-place a module minted in this call
          // (the feature-cards case — one card module, three placements;
          // ordering.order minted it first). The entry's own `content`
          // mints/binds its own instance as usual.
          const resolved = localRefs.get(entry.moduleId.$ref);
          if (!resolved) throw new SkipEntry();
          moduleId = resolved.moduleId;
        } else if (entry.moduleId !== undefined) {
          const mod = placedModules.get(i) as PlacedModuleRow;
          moduleId = entry.moduleId;
          // §2 — surface any authoring field that DIFFERS from the module's stored
          // value (or is structural, which placement can never apply). A matching
          // metadata field is a harmless redundant label → no note.
          const ignored = ignoredAuthoring(entry, mod);
          if (ignored.length > 0) ignoredAuthoringByIndex[String(i)] = ignored;
        } else {
          // Mint mode — displayName + html were checked in step 2.
          const displayName = entry.displayName as string;
          const html = entry.html as string;
          const twin = mintedByHtml.get(html);
          if (twin && repeatsMint(entry, input.modules[twin.index] as BuildPageModuleEntry)) {
            moduleId = twin.moduleId;
            reusedMintByIndex[String(i)] = twin.index;
          } else {
            // Delegate to modules.create (extractor fallback, type
            // derivation, slug-dup check, media usage, snapshot).
            const parsed = moduleCreateSchema.parse(mintInput(entry, displayName, html, i));
            const created = await runNested(() => createModuleOp.handler(ctx, parsed, tx));
            if (!created.ok) {
              nestedProblem(at, created.error, "modules.create failed");
              failEntry(entry);
              continue;
            }
            wrote = true;
            minted = true;
            moduleId = (created.value as { moduleId: string }).moduleId;
            if (!mintedByHtml.has(html)) mintedByHtml.set(html, { index: i, moduleId });
            const extracted = (
              created.value as { extractedFields?: { name: string; kind: string }[] }
            ).extractedFields;
            if (extracted && extracted.length > 0) {
              extractedFieldsByIndex[String(i)] = extracted.map((f) => ({
                name: f.name,
                kind: f.kind,
              }));
            }
          }
        }

        // Content resolution — every placement binds a content_instance
        // (page_modules.content_instance_id is NOT NULL).
        let content: BuildPageContent = entry.content ?? { source: "inline", values: {} };
        // Resolve {"$ref": "<handle>"} markers against the referenced
        // entries' minted ids BEFORE validation — the module/module-list field
        // validator expects the real {moduleId, contentInstanceId} shape.
        if (content.source !== "existing") {
          content = {
            ...content,
            values: resolveLocalRefs(content.values) as Record<string, unknown>,
          };
        }
        let contentInstanceId: string;
        let syncMode: "synced" | "unsynced";
        if (content.source === "existing") {
          contentInstanceId = content.contentInstanceId;
          syncMode = content.syncMode;
        } else {
          // inline → private unsynced row; shared → reusable row with
          // purpose + (default) synced binding. Both delegate to
          // content_instances.create so nested-ref + field-shape
          // validation runs and names every offending FIELD.
          const ciInput = contentInstanceCreateSchema.parse(contentCreateInput(content, moduleId));
          const ciCreated = await runNested(() =>
            createContentInstanceOp.handler(ctx, ciInput, tx),
          );
          if (!ciCreated.ok) {
            nestedProblem([...at, "content"], ciCreated.error, "content_instances.create failed");
            failEntry(entry);
            continue;
          }
          wrote = true;
          contentInstanceId = (ciCreated.value as { contentInstanceId: string }).contentInstanceId;
          syncMode = content.source === "shared" ? content.syncMode : "unsynced";
        }

        // Register the local handle for later entries' {"$ref"} values.
        if (entry.ref !== undefined) {
          localRefs.set(entry.ref, { moduleId, contentInstanceId });
        }
        if (entry.blockName === undefined) {
          // Detached (nested-only) entry: minted + content-bound, no
          // placement. The schema guarantees `ref` is set here.
          detached.push({ index: i, ref: entry.ref as string, moduleId, contentInstanceId });
          continue;
        }
        additionByIndex.set(i, {
          blockName: entry.blockName,
          moduleId,
          contentInstanceId,
          syncMode,
          ...(entry.position !== undefined ? { position: entry.position } : {}),
        });
        mintedByIndex.set(i, minted);
      } catch (e) {
        if (e instanceof SkipEntry) {
          failEntry(entry);
          continue;
        }
        if (e instanceof NestedThrow) {
          // A driver error aborts the Postgres transaction: nothing after
          // it can run. Report it under this entry with what was found.
          const mapped = thrownToQueryError("pages.build_page", e.thrown, "write");
          const isSlug =
            mapped.kind === "HandlerError" &&
            mapped.pgDetail?.code === "23505" &&
            entry.html !== undefined;
          problem(at, describeNested(mapped), {
            ...(isSlug
              ? { next: "Set a different displayName (the module slug derives from it)." }
              : {}),
          });
          if (failureKindOf(mapped) === "internal") problemInternal = true;
          wrote = true;
          return failProblems();
        }
        throw e;
      }
    }
    if (problems.length > 0) return failProblems();
    const placedIndices = [...additionByIndex.keys()].sort((a, b) => a - b);
    const additions = placedIndices.map((i) => additionByIndex.get(i) as ResolvedBuildPlacement);
    const mintedFlags = placedIndices.map((i) => mintedByIndex.get(i) ?? false);

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

    // The page's first meta description, in the same transaction (a
    // staging build refuses a published page without one — §2 fill-once
    // through the autofill handler itself, so the two paths cannot drift).
    let metaDescription: "written" | "unchanged" | "kept-existing" | null = null;
    if (input.page.metaDescription !== undefined) {
      const stored = createdPage
        ? []
        : ((await tx.execute(sql`
            SELECT 1 AS found FROM ${pageSeoViewSql(ctx.chatBranchId, [pageId])} s
            WHERE btrim(coalesce(s.meta_description, '')) <> ''
              AND s.meta_description <> ${input.page.metaDescription}
          `)) as unknown as { found: number }[]);
      if (stored.length > 0) {
        metaDescription = "kept-existing";
      } else {
        const filled = await pagesSeoAutofillOp.handler(
          ctx,
          { pageId, metaDescription: input.page.metaDescription },
          tx,
        );
        if (!filled.ok) {
          // Throw, never `return err`: the page and its modules are written.
          nestedProblem(["page", "metaDescription"], filled.error, "metaDescription");
          return failProblems();
        }
        metaDescription = filled.value.alreadyFilled ? "unchanged" : "written";
      }
    }

    // Stamp the import→page linkage LAST, once pageId is final. Idempotent:
    // on a rebuild `accepted_page_id` already equals pageId; on a first
    // build (or when the prior link pointed at a since-deleted page) it now
    // points at the live page. The pointer is what inventory /
    // media-migration reads resolve on (slug-independent).
    if (importPageId !== undefined) {
      await tx.execute(sql`
        UPDATE import_pages
           SET accepted_page_id = ${pageId}::uuid,
               accepted_at = COALESCE(accepted_at, now())
         WHERE id = ${importPageId}::uuid
      `);
    }

    return ok({
      pageId,
      createdPage,
      placements: plan.appended.map((p, i) => ({
        index: placedIndices[i] as number,
        blockName: p.blockName,
        position: p.position,
        moduleId: p.moduleId,
        contentInstanceId: p.contentInstanceId,
        syncMode: p.syncMode,
        minted: mintedFlags[i] ?? false,
      })),
      detached,
      extractedFieldsByIndex,
      ignoredAuthoringByIndex,
      reusedMintByIndex,
      metaDescription,
    });
  },
});
