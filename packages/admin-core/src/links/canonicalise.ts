// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout C) — write-time canonicalisation of internal links,
 * the I/O half. The pure rules live in `@caelo-cms/shared`
 * (`link-canonicalise.ts`); this module builds the site lookup they run
 * against and gives the write ops one call.
 *
 * Every write op that persists a link-carrying surface runs its input
 * through {@link canonicaliseLinksForWrite} BEFORE persisting, inside
 * the op's own transaction — the Validator boundary for checks that
 * need the database (a Zod schema cannot know which pages exist):
 *
 *   - content values      content_instances.create / .set_values (and
 *                         everything routed through them: create_many,
 *                         set_values_many, page_module_content.*, build_page)
 *   - module HTML + field defaults   modules.create / .update (and update_many)
 *   - structured sets     structured_sets.set
 *   - imports             imports.compose_from_run, in report mode
 *
 * Internal copies (fork, duplicate, chat merge, snapshot revert) copy
 * stored references verbatim and are not re-canonicalised. Undo restores
 * whatever was stored, references included.
 *
 * Rollout E: inside a chat that rebuilds an active site import, a link to
 * one of that run's planned-but-unbuilt pages is kept literal and
 * recorded against the run (`import-targets.ts`) instead of refused;
 * `imports.resolve_links` converts it once the page exists.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  collectLinkLiterals,
  describeLinkIssues,
  type ExecutionContext,
  type LinkCanonicaliseIssue,
  type LinkCanonicaliseRun,
  type LinkTargetLookup,
  linkCanonicaliseRun,
  normaliseLinkPath,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { loadActiveImportTargets, recordPendingImportLinks } from "./import-targets.js";
import { type LinkTargets, loadLinkTargets } from "./link-targets.js";

/**
 * Cheap pre-check over a write's raw input: can it contain anything the
 * canonicaliser would touch? Most content edits carry no link at all and
 * skip the site lookup entirely.
 */
export function mayContainInternalLink(input: unknown): boolean {
  const s = typeof input === "string" ? input : JSON.stringify(input ?? null);
  return s.includes('"/') || s.includes("'/") || s.includes("caelo:") || /https?:\/\//i.test(s);
}

/**
 * The site lookup for one scope: pages, media, redirects, own hosts.
 *
 * @param extraOwnHosts hosts that count as this site besides the base
 *   URL and the public domains — an import passes the migrated site's
 *   host, whose absolute self-links mean its (now imported) pages.
 * @param pendingPagePaths planned pages of an active import that do not
 *   exist yet (rollout E, see `import-targets.ts`).
 */
export async function loadLinkTargetLookup(
  tx: TransactionRunner,
  chatBranchId: string | null,
  extraOwnHosts: readonly string[] = [],
  pendingPagePaths?: ReadonlySet<string>,
): Promise<LinkTargetLookup & { readonly targets: LinkTargets }> {
  const targets = await loadLinkTargets(tx, chatBranchId);
  const byPath = new Map<string, string>();
  for (const p of targets.pages) byPath.set(normaliseLinkPath(p.path), p.id);
  const pageIds = new Set(targets.pages.map((p) => p.id));
  const bySlug = new Map(targets.media.map((m) => [m.slug, m.id]));
  const mediaIds = new Set(targets.media.map((m) => m.id));

  // An old URL that 301s to a page IS that page (a rename left the
  // redirect behind; links written with the old path mean the page).
  const redirects = (await tx.execute(sql`
    SELECT from_path, to_path FROM redirects WHERE status_code IN (301, 302, 307, 308)
  `)) as unknown as { from_path: string; to_path: string }[];
  const redirectTo = new Map(
    redirects.map((r) => [normaliseLinkPath(r.from_path), normaliseLinkPath(r.to_path)]),
  );

  const hosts = new Set<string>(extraOwnHosts.map((h) => h.toLowerCase()));
  const base = (await tx.execute(sql`
    SELECT site_base_url FROM site_defaults WHERE id = 1 LIMIT 1
  `)) as unknown as { site_base_url: string | null }[];
  const siteBaseUrl = base[0]?.site_base_url;
  if (siteBaseUrl) {
    try {
      hosts.add(new URL(siteBaseUrl).host.toLowerCase());
    } catch {
      // A malformed stored base URL is reported by every build; here it
      // only means no absolute URL counts as own-domain.
    }
  }
  const domains = (await tx.execute(sql`
    SELECT hostname FROM domains WHERE kind = 'public'
  `)) as unknown as { hostname: string }[];
  for (const d of domains) hosts.add(d.hostname.toLowerCase());

  return {
    targets,
    pageIdForPath(path) {
      const direct = byPath.get(path);
      if (direct !== undefined) return direct;
      const to = redirectTo.get(path);
      return to === undefined ? null : (byPath.get(to) ?? null);
    },
    mediaIdForSlug: (slug) => bySlug.get(slug) ?? null,
    pageExists: (id) => pageIds.has(id),
    mediaExists: (id) => mediaIds.has(id),
    isOwnHost: (host) => hosts.has(host),
    ...(pendingPagePaths && pendingPagePaths.size > 0
      ? { isPendingPagePath: (path: string) => pendingPagePaths.has(path) }
      : {}),
  };
}

/** The outcome of canonicalising one write. */
export type CanonicaliseOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly issues: readonly LinkCanonicaliseIssue[] }
  | {
      readonly ok: false;
      readonly message: string;
      readonly issues: readonly LinkCanonicaliseIssue[];
    };

/**
 * Canonicalise one write's link-carrying input.
 *
 * @param input the raw input, for the cheap pre-check only.
 * @param apply runs the shared canonicalise functions against the run.
 * @param opts.previous the stored state this write replaces; its link
 *   literals are grandfathered (see shared `link-canonicalise.ts`).
 * @param opts.mode `strict` refuses on any issue with an AI-actionable
 *   message; `report` (imports) keeps unresolved literals and returns
 *   them as issues.
 */
export async function canonicaliseLinksForWrite<T>(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  input: unknown,
  apply: (run: LinkCanonicaliseRun) => T,
  opts: { readonly previous?: unknown; readonly mode?: "strict" | "report" } = {},
): Promise<CanonicaliseOutcome<T>> {
  if (!mayContainInternalLink(input)) {
    return { ok: true, value: apply(passthroughRun()), issues: [] };
  }
  // Rollout E: inside a chat that rebuilds an import, links to that
  // run's planned-but-unbuilt pages are kept literal and recorded.
  const imports = ctx.chatBranchId ? await loadActiveImportTargets(tx, ctx.chatBranchId) : null;
  const lookup = await loadLinkTargetLookup(
    tx,
    ctx.chatBranchId ?? null,
    imports?.sourceHosts ?? [],
    imports ? new Set(imports.runsByPath.keys()) : undefined,
  );
  const run = linkCanonicaliseRun(lookup, {
    mode: opts.mode ?? "strict",
    grandfathered: opts.previous === undefined ? new Set() : collectLinkLiterals(opts.previous),
  });
  const value = apply(run);
  if (run.mode === "strict" && run.issues.length > 0) {
    return { ok: false, message: describeLinkIssues(run.issues), issues: run.issues };
  }
  if (imports && run.pending.length > 0) {
    await recordPendingImportLinks(tx, imports, run.pending);
  }
  return { ok: true, value, issues: run.issues };
}

/**
 * A run for input the pre-check proved link-free: nothing in it reaches
 * the lookup, so the lookup never answers (it would be a bug if it did).
 */
function passthroughRun(): LinkCanonicaliseRun {
  const unreachable = (): never => {
    throw new Error("link canonicaliser: link-free input reached the site lookup");
  };
  return linkCanonicaliseRun({
    pageIdForPath: unreachable,
    mediaIdForSlug: unreachable,
    pageExists: unreachable,
    mediaExists: unreachable,
    isOwnHost: unreachable,
  });
}
