// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout C, maintainer decision on open point 1: option b) —
 * finalising an import run's internal links.
 *
 * While a run is active, links its rebuild writes to the run's planned
 * but not-yet-built pages are kept literal and recorded in
 * `import_run_links` against the content that holds them (see
 * `links/import-targets.ts`). Finalising rewrites each recorded piece of
 * content through its own write op — the same canonicalisation, snapshot,
 * lock and audit as any edit, on the run's chat branch — so every link
 * whose page now exists becomes a page reference in one go. A recorded
 * link that still matches no page stays as written and is marked
 * `unresolved`: a finding of the run (`get_import_run_report`), with
 * where it is and what to do. Never guessed, never a fallback.
 */

import { defineOperation, OperationAbortError, type TransactionRunner } from "@caelo-cms/query-api";
import {
  collectLinkLiterals,
  type ExecutionContext,
  err,
  moduleUpdateSchema,
  ok,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { pendingSnapshotSql } from "../draft.js";
import type { ImportLinkEntityKind } from "../links/import-targets.js";
import {
  loadContentInstanceStateWithBranchOverlay,
  loadModuleStateWithBranchOverlay,
} from "../snapshots/load.js";
import { setContentInstanceValuesOp } from "./content/content-instances.js";
import { updateModuleOp } from "./content/modules.js";
import { setStructuredSetOp } from "./structured_sets.js";

/** One recorded link that still matches no page. */
export interface ImportLinkFinding {
  readonly value: string;
  readonly entityKind: ImportLinkEntityKind;
  readonly entityId: string;
  readonly location: string;
}

/** The outcome of finalising one run's links. */
export interface ImportLinkFinalisation {
  /** Recorded links now stored as page references. */
  readonly resolved: number;
  /** Recorded links that still match no page — the run's findings. */
  readonly unresolved: readonly ImportLinkFinding[];
}

/** Why a run's links cannot be finalised. */
export class ImportLinkFinalisationError extends Error {}

interface RunScope {
  readonly status: string;
  /** The rebuilding chat's live branch, or null (no chat / discarded). */
  readonly branchId: string | null;
  readonly chatSessionId: string | null;
}

async function loadRunScope(tx: TransactionRunner, runId: string): Promise<RunScope | null> {
  const rows = (await tx.execute(sql`
    SELECT r.status, r.chat_session_id::text AS chat_session_id,
           cs.chat_branch_id::text AS branch_id
      FROM import_runs r
      LEFT JOIN chat_sessions cs ON cs.id = r.chat_session_id AND cs.discarded_at IS NULL
     WHERE r.id = ${runId}::uuid
  `)) as unknown as { status: string; chat_session_id: string | null; branch_id: string | null }[];
  const r = rows[0];
  return r ? { status: r.status, branchId: r.branch_id, chatSessionId: r.chat_session_id } : null;
}

/** A structured set as the chat's branch has it (pending snapshot wins). */
async function loadSetState(
  tx: TransactionRunner,
  setId: string,
  branchId: string | null,
): Promise<{ kind: string; slug: string; displayName: string; items: unknown[] } | null> {
  if (branchId) {
    const branched = (await tx.execute(sql`
      SELECT sss.state
        FROM structured_set_snapshots sss
        JOIN site_snapshots ss ON ss.id = sss.site_snapshot_id
       WHERE sss.structured_set_id = ${setId}::uuid
         AND ss.chat_branch_id = ${branchId}::uuid AND ${pendingSnapshotSql()}
       ORDER BY ss.created_at DESC LIMIT 1
    `)) as unknown as { state: unknown }[];
    const raw = branched[0]?.state;
    if (raw !== undefined) {
      const s = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
        kind?: string;
        slug?: string;
        displayName?: string;
        items?: unknown[];
        deletedAt?: string | null;
      };
      if (s.deletedAt) return null;
      if (s.kind && s.slug && s.displayName && Array.isArray(s.items)) {
        return { kind: s.kind, slug: s.slug, displayName: s.displayName, items: s.items };
      }
      throw new ImportLinkFinalisationError(
        `structured set ${setId}: its latest branch snapshot has no kind/slug/displayName/items`,
      );
    }
  }
  const rows = (await tx.execute(sql`
    SELECT kind, slug, display_name, items FROM structured_sets WHERE id = ${setId}::uuid
  `)) as unknown as { kind: string; slug: string; display_name: string; items: unknown }[];
  const r = rows[0];
  if (!r) return null;
  const items = typeof r.items === "string" ? JSON.parse(r.items) : r.items;
  return { kind: r.kind, slug: r.slug, displayName: r.display_name, items: items as unknown[] };
}

/** Load one entity's link-carrying state as the run's chat sees it. */
async function loadEntity(
  tx: TransactionRunner,
  kind: ImportLinkEntityKind,
  id: string,
  branchId: string | null,
): Promise<unknown | null> {
  if (kind === "content_instance") {
    const s = await loadContentInstanceStateWithBranchOverlay(tx, id, branchId);
    return s === null || s.deletedAt !== null ? null : s.values;
  }
  if (kind === "module") {
    const s = await loadModuleStateWithBranchOverlay(tx, id, branchId);
    return s === null || s.deletedAt !== null ? null : { html: s.html, fields: s.fields };
  }
  return loadSetState(tx, id, branchId);
}

/**
 * Rewrite one entity through its own write op, so the links recorded
 * against it are canonicalised with every page that exists now.
 */
async function rewriteEntity(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  kind: ImportLinkEntityKind,
  id: string,
  state: unknown,
): Promise<void> {
  let r: { ok: true } | { ok: false; error: unknown };
  if (kind === "content_instance") {
    r = await setContentInstanceValuesOp.handler(
      ctx,
      { id, values: state as Record<string, unknown> },
      tx,
    );
  } else if (kind === "module") {
    const m = state as { html: string; fields: unknown };
    const input = moduleUpdateSchema.safeParse({ moduleId: id, html: m.html, fields: m.fields });
    if (!input.success) {
      throw new ImportLinkFinalisationError(
        `module ${id}: its stored code does not pass modules.update (${input.error.issues
          .map((i) => i.message)
          .join("; ")}); fix the module, then resolve the run's links again`,
      );
    }
    r = await updateModuleOp.handler(ctx, input.data, tx);
  } else {
    const s = state as { kind: string; slug: string; displayName: string; items: unknown[] };
    r = await setStructuredSetOp.handler(
      ctx,
      {
        kind: s.kind as Parameters<typeof setStructuredSetOp.handler>[1]["kind"],
        slug: s.slug,
        displayName: s.displayName,
        items: s.items,
      },
      tx,
    );
  }
  if (!r.ok) {
    const e = r.error as { message?: string };
    throw new ImportLinkFinalisationError(
      `rewriting ${kind} ${id} failed: ${e.message ?? JSON.stringify(r.error)}`,
    );
  }
}

/**
 * Finalise `runId`'s recorded links in `tx`.
 *
 * @param ctx the caller; the rewrites run as this actor on the run's
 *   chat branch (main when the chat is gone).
 * @returns null when there is no such run.
 * @throws ImportLinkFinalisationError when a rewrite is refused — the
 *   transaction must roll back, a half-finalised run would misreport.
 */
export async function finaliseImportLinks(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  runId: string,
): Promise<ImportLinkFinalisation | null> {
  const scope = await loadRunScope(tx, runId);
  if (!scope) return null;
  const rows = (await tx.execute(sql`
    SELECT value, entity_kind, entity_id::text AS entity_id, location
      FROM import_run_links
     WHERE run_id = ${runId}::uuid AND status <> 'resolved'
     ORDER BY entity_kind, entity_id, value
  `)) as unknown as {
    value: string;
    entity_kind: ImportLinkEntityKind;
    entity_id: string;
    location: string;
  }[];
  if (rows.length === 0) return { resolved: 0, unresolved: [] };

  const writeCtx: ExecutionContext = {
    ...ctx,
    ...(scope.branchId ? { chatBranchId: scope.branchId } : { chatBranchId: undefined }),
    ...(scope.branchId && scope.chatSessionId ? { chatTaskId: scope.chatSessionId } : {}),
  };
  const byEntity = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.entity_kind}:${r.entity_id}`;
    byEntity.set(key, [...(byEntity.get(key) ?? []), r]);
  }

  let resolved = 0;
  const unresolved: ImportLinkFinding[] = [];
  for (const recorded of byEntity.values()) {
    const first = recorded[0];
    if (!first) continue;
    const { entity_kind: kind, entity_id: id } = first;
    const before = await loadEntity(tx, kind, id, scope.branchId);
    if (before === null) {
      // The content was deleted since: its links went with it.
      await tx.execute(sql`
        DELETE FROM import_run_links
         WHERE run_id = ${runId}::uuid AND entity_kind = ${kind} AND entity_id = ${id}::uuid
      `);
      continue;
    }
    const present = collectLinkLiterals(before);
    if (recorded.some((r) => present.has(r.value))) {
      await rewriteEntity(tx, writeCtx, kind, id, before);
    }
    const after = collectLinkLiterals(await loadEntity(tx, kind, id, scope.branchId));
    for (const r of recorded) {
      const still = after.has(r.value);
      await tx.execute(sql`
        UPDATE import_run_links
           SET status = ${still ? "unresolved" : "resolved"}, updated_at = now()
         WHERE run_id = ${runId}::uuid AND value = ${r.value}
           AND entity_kind = ${kind} AND entity_id = ${id}::uuid
      `);
      if (still) {
        unresolved.push({ value: r.value, entityKind: kind, entityId: id, location: r.location });
      } else {
        resolved += 1;
      }
    }
  }
  return { resolved, unresolved };
}

const unresolvedSchema = z.object({
  value: z.string(),
  entityKind: z.enum(["content_instance", "module", "structured_set"]),
  entityId: z.string(),
  location: z.string(),
});

/** Tool and op wording for the next step on an unresolved link. */
export const UNRESOLVED_IMPORT_LINK_NEXT_STEP =
  "Each still matches no page: build the page it names (with its importPageId), or point the link at an existing page's path " +
  "(list_pages), or write the full https:// URL if it really goes to another site — then call resolve_import_links again.";

export const resolveImportLinksOp = defineOperation({
  name: "imports.resolve_links",
  // Routine (CLAUDE.md §11): it rewrites only the content the run's own
  // rebuild recorded, through the normal write ops, on the run's chat
  // branch — snapshotted, undone with the chat. An AI may call it only
  // from the run's own chat.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ runId: z.string().uuid() }).strict(),
  output: z.object({ resolved: z.number(), unresolved: z.array(unresolvedSchema) }),
  handler: async (ctx, input, tx) => {
    const scope = await loadRunScope(tx, input.runId);
    if (!scope) {
      return err({
        kind: "HandlerError",
        operation: "imports.resolve_links",
        message: `no import run ${input.runId}. Next step: list_import_runs shows the run ids.`,
      });
    }
    if (scope.status === "completed" || scope.status === "failed") {
      return err({
        kind: "HandlerError",
        operation: "imports.resolve_links",
        message:
          `import run ${input.runId} is ${scope.status}; its links were finalised when it ended. ` +
          "Next step: get_import_run_report lists the links that still match no page — fix each with a normal edit (an existing page's path).",
      });
    }
    if (
      ctx.actorKind === "ai" &&
      (scope.branchId === null || scope.branchId !== (ctx.chatBranchId ?? null))
    ) {
      return err({
        kind: "HandlerError",
        operation: "imports.resolve_links",
        message:
          `import run ${input.runId} is rebuilt in another chat (or its chat was discarded), so its links cannot be resolved from this chat. ` +
          "Next step: resolve them from the chat that runs the import; the run's cleanup (cleanup_import_run) finalises them too.",
      });
    }
    let out: ImportLinkFinalisation | null;
    try {
      out = await finaliseImportLinks(tx, ctx, input.runId);
    } catch (e) {
      if (!(e instanceof ImportLinkFinalisationError)) throw e;
      // Thrown, not returned: earlier rewrites of this call must roll back
      // with it (a `return err` would commit them).
      throw new OperationAbortError({
        kind: "HandlerError",
        operation: "imports.resolve_links",
        message: `${e.message}. Nothing was changed.`,
      });
    }
    if (!out) {
      return err({
        kind: "HandlerError",
        operation: "imports.resolve_links",
        message: `no import run ${input.runId}. Next step: list_import_runs shows the run ids.`,
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "imports.resolve_links",
      input,
      succeeded: true,
      entityId: input.runId,
      resultSummary: `resolved ${out.resolved}, unresolved ${out.unresolved.length}`,
    });
    return ok({ resolved: out.resolved, unresolved: [...out.unresolved] });
  },
});
