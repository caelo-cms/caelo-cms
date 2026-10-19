// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout C) — the per-surface entry points the write ops
 * call. Each canonicalises one surface's input and returns either the
 * stored form or an AI-actionable message; the op persists the stored
 * form or refuses the write with that message. See `canonicalise.ts`
 * for which ops call which.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  type CanonicaliseField,
  canonicaliseContentValues,
  canonicaliseFieldDefaults,
  canonicaliseHtmlLinks,
  canonicaliseJsonLinks,
  type ExecutionContext,
  linkCanonicaliseRun,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import {
  type CanonicaliseOutcome,
  canonicaliseLinksForWrite,
  loadLinkTargetLookup,
  mayContainInternalLink,
} from "./canonicalise.js";

/**
 * Content values of one instance of `moduleId`. Field kinds come from
 * the module's stored schema (a `url` field's whole value is a link; a
 * `text` field's is not).
 *
 * @param previous the values this write replaces (grandfathering), or
 *   undefined for a create.
 */
export async function canonicaliseInstanceValues(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  moduleId: string,
  values: Readonly<Record<string, unknown>>,
  previous: unknown,
): Promise<CanonicaliseOutcome<Record<string, unknown>>> {
  if (!mayContainInternalLink(values)) return { ok: true, value: { ...values }, issues: [] };
  const fields = await loadModuleFields(tx, moduleId);
  return canonicaliseLinksForWrite(
    tx,
    ctx,
    values,
    (run) => canonicaliseContentValues(fields, values, run),
    { previous },
  );
}

/**
 * A module's HTML and field defaults (layout chrome content lives in
 * the defaults). Either may be undefined on a partial update.
 *
 * @param previous the module state this write replaces, or undefined.
 */
export async function canonicaliseModuleCode<F extends CanonicaliseField>(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  code: { readonly html: string | undefined; readonly fields: readonly F[] | undefined },
  previous: { readonly html: string; readonly fields: unknown } | undefined,
): Promise<CanonicaliseOutcome<{ html: string | undefined; fields: F[] | undefined }>> {
  return canonicaliseLinksForWrite(
    tx,
    ctx,
    code,
    (run) => ({
      html: code.html === undefined ? undefined : canonicaliseHtmlLinks(code.html, run, "html"),
      fields: code.fields === undefined ? undefined : canonicaliseFieldDefaults(code.fields, run),
    }),
    { previous },
  );
}

/**
 * Structured-set items (nav menus, link lists): every `href` at any
 * depth (submenu `children` included) is a link.
 */
export async function canonicaliseSetItems(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  items: readonly unknown[],
  previous: unknown,
): Promise<CanonicaliseOutcome<unknown[]>> {
  return canonicaliseLinksForWrite(
    tx,
    ctx,
    items,
    (run) => canonicaliseJsonLinks(items, run, "items") as unknown[],
    { previous },
  );
}

/** One link an import could not turn into a reference. */
export interface UnresolvedImportLink {
  readonly moduleId: string;
  readonly value: string;
}

/**
 * Canonicalise the HTML of the modules an import just composed, in
 * REPORT mode (maintainer decision 3 on #724): links that resolve to an
 * imported page (directly, through the old-URL 301 the import wrote, or
 * as an absolute URL on the migrated site's host) become references;
 * the rest stay literal and are returned — never guessed.
 *
 * Runs once after every page of the run exists, so a header composed
 * with the first page still resolves links to the last one.
 */
export async function canonicaliseImportedModules(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  moduleIds: readonly string[],
  sourceUrl: string,
): Promise<UnresolvedImportLink[]> {
  if (moduleIds.length === 0) return [];
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, html FROM modules
    WHERE id IN (${sql.join(
      moduleIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `)) as unknown as { id: string; html: string }[];
  const candidates = rows.filter((r) => mayContainInternalLink(r.html));
  if (candidates.length === 0) return [];
  let sourceHost: string[] = [];
  try {
    sourceHost = [new URL(sourceUrl).host];
  } catch {
    // An unparsable source URL only means its absolute links stay literal.
  }
  const lookup = await loadLinkTargetLookup(tx, ctx.chatBranchId ?? null, sourceHost);
  const unresolved: UnresolvedImportLink[] = [];
  for (const r of candidates) {
    const run = linkCanonicaliseRun(lookup, { mode: "report" });
    const next = canonicaliseHtmlLinks(r.html, run, "html");
    for (const i of run.issues) unresolved.push({ moduleId: r.id, value: i.value });
    if (next !== r.html) {
      await tx.execute(sql`UPDATE modules SET html = ${next} WHERE id = ${r.id}::uuid`);
    }
  }
  return unresolved;
}

async function loadModuleFields(
  tx: TransactionRunner,
  moduleId: string,
): Promise<CanonicaliseField[]> {
  const rows = (await tx.execute(sql`
    SELECT fields FROM modules WHERE id = ${moduleId}::uuid LIMIT 1
  `)) as unknown as { fields: unknown }[];
  const raw = rows[0]?.fields;
  const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (f): f is CanonicaliseField =>
      typeof f === "object" &&
      f !== null &&
      typeof (f as { name?: unknown }).name === "string" &&
      typeof (f as { kind?: unknown }).kind === "string",
  );
}
