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
import { loadModuleStateWithBranchOverlay } from "../snapshots/load.js";
import {
  type CanonicaliseOutcome,
  canonicaliseLinksForWrite,
  loadLinkTargetLookup,
  probeLinkLookup,
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
  // Probe before loading the module's fields: with every value treated
  // as a URL field (the widest reading), link-free values skip both the
  // field load and the site lookup.
  const widest = Object.keys(values).map((name) => ({ name, kind: "url" }));
  const probe = probeLinkLookup((run) => canonicaliseContentValues(widest, values, run));
  if (!probe.needsLookup) return { ok: true, value: { ...values }, issues: [] };
  const fields = await loadModuleFields(tx, moduleId, ctx.chatBranchId ?? null);
  if (fields === null) {
    return {
      ok: false,
      message:
        `Module ${moduleId} does not exist (or was deleted), so its content's links cannot be checked. ` +
        "Next step: list_modules shows the modules that exist; use one of those.",
      issues: [],
    };
  }
  return canonicaliseLinksForWrite(
    tx,
    ctx,
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
    (run) => canonicaliseJsonLinks(items, run, "items") as unknown[],
    { previous },
  );
}

/**
 * A layout's HTML (the page frame around the blocks). Links in it are
 * stored as references exactly like module HTML.
 *
 * @param previousHtml the HTML this write replaces, or undefined.
 */
export async function canonicaliseLayoutHtml(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  html: string,
  previousHtml: string | undefined,
): Promise<CanonicaliseOutcome<string>> {
  return canonicaliseLinksForWrite(tx, ctx, (run) => canonicaliseHtmlLinks(html, run, "html"), {
    previous: previousHtml === undefined ? undefined : { html: previousHtml },
  });
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
 *
 * The UPDATE below rewrites module rows this same compose transaction
 * just inserted (or upserted); it is the second half of that one write,
 * not a separate edit, so it deliberately emits no snapshot and does not
 * bump `updated_at` — it inherits whatever the compose does for the row.
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
  const candidates = rows.filter(
    (r) => probeLinkLookup((run) => canonicaliseHtmlLinks(r.html, run, "html")).needsLookup,
  );
  if (candidates.length === 0) return [];
  const lookup = await loadLinkTargetLookup(
    tx,
    ctx.chatBranchId ?? null,
    sourceSiteHosts(sourceUrl),
  );
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

/**
 * The migrated site's host and its www / apex twin: a site crawled at
 * `https://example.com` links itself as `https://www.example.com/...` as
 * often as not, and both mean its (now imported) pages. An unparsable
 * source URL only means its absolute links stay literal (and reported).
 */
export function sourceSiteHosts(sourceUrl: string): string[] {
  let u: URL;
  try {
    u = new URL(sourceUrl);
  } catch {
    return [];
  }
  const host = u.hostname.toLowerCase();
  const port = u.port ? `:${u.port}` : "";
  const twin = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
  return [`${host}${port}`, `${twin}${port}`];
}

/**
 * The module's declared fields as the chat sees them (its branch's
 * pending edits overlaid on main), or null when the module does not
 * exist — never an empty list standing in for a missing module.
 */
async function loadModuleFields(
  tx: TransactionRunner,
  moduleId: string,
  chatBranchId: string | null,
): Promise<CanonicaliseField[] | null> {
  const state = await loadModuleStateWithBranchOverlay(tx, moduleId, chatBranchId);
  if (state === null || state.deletedAt !== null) return null;
  return state.fields.filter(
    (f): f is CanonicaliseField =>
      typeof f === "object" &&
      f !== null &&
      typeof (f as { name?: unknown }).name === "string" &&
      typeof (f as { kind?: unknown }).kind === "string",
  );
}
