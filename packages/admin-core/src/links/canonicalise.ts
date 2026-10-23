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
 *   - content values      content_instances.create / .set_values via
 *                         `canonicaliseInstanceValues` (and everything routed
 *                         through them: create_many, set_values_many,
 *                         page_module_content.set / set_many / patch_fields,
 *                         build_page incl. detached entries,
 *                         imports.resolve_links). No other path writes
 *                         authored values: the remaining INSERTs mint empty
 *                         rows or copy stored values (see below).
 *   - module HTML + field defaults   modules.create / .update (and update_many)
 *   - layout HTML         layouts.create / .update
 *   - structured sets     structured_sets.set
 *   - imports             imports.compose_from_run, in report mode
 *
 * NOT covered (deliberately, out of scope for rollout C): CSS `url(...)`
 * media references — in inline `style` attributes and in the module /
 * layout `css` columns. They stay literal `/_caelo/media/<slug>` URLs,
 * resolved at build time as before; a renamed or deleted asset there is
 * caught by the media usage guards, not by a stored reference.
 *
 * Inside a chat that rebuilds an active site import, a link to one of
 * that run's planned-but-unbuilt pages is kept literal and recorded
 * against the run (`import-targets.ts`) instead of refused, for the
 * content values, module code and structured sets the run's
 * finalisation (`imports.resolve_links`) can rewrite. Layout HTML and
 * plugin-owned values keep the strict refusal.
 *
 * Internal copies (fork, duplicate, chat merge, snapshot revert) copy
 * stored references verbatim and are not re-canonicalised. Undo restores
 * whatever was stored, references included.
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
import {
  type ActiveImportTargets,
  type ImportLinkEntityKind,
  loadActiveImportTargets,
  type PendingLinkRecord,
} from "./import-targets.js";
import { type LinkTargets, loadLinkTargets } from "./link-targets.js";

/**
 * Does `apply` reach the site lookup at all? Most content edits carry no
 * link and skip loading pages / media / redirects. The probe runs the
 * canonicaliser itself against a lookup that only records being asked,
 * so "is there a link here" is decided by exactly the positions, trimming
 * and srcset splitting the real run uses — a hand-written string test
 * drifted from those (` /about` with a leading space slipped past it).
 *
 * When the lookup is never asked, the canonicaliser cannot have produced
 * a reference (that needs an answer), so `value` is the final result. It
 * CAN have recorded an issue that needs no answer — a malformed
 * `caelo:page/…` reference is broken whatever the site holds — so a probe
 * that recorded one also takes the real run, which reports it.
 */
export function probeLinkLookup<T>(apply: (run: LinkCanonicaliseRun) => T): {
  readonly needsLookup: boolean;
  readonly value: T;
} {
  let asked = false;
  const ask = (): null => {
    asked = true;
    return null;
  };
  const run = linkCanonicaliseRun({
    pageIdForPath: ask,
    mediaIdForSlug: ask,
    pageExists: () => ask() ?? false,
    mediaExists: () => ask() ?? false,
    isOwnHost: () => ask() ?? false,
  });
  const value = apply(run);
  return { needsLookup: asked || run.issues.length > 0, value };
}

/**
 * The site lookup for one scope: pages, media, redirects, own hosts.
 *
 * @param extraOwnHosts hosts that count as this site besides the base
 *   URL and the public domains — an import passes the migrated site's
 *   host, whose absolute self-links mean its (now imported) pages.
 * @param imports the active import runs of the writing chat (see
 *   `import-targets.ts`): a planned page already rebuilt resolves to its
 *   page, one not built yet is pending.
 */
export async function loadLinkTargetLookup(
  tx: TransactionRunner,
  chatBranchId: string | null,
  extraOwnHosts: readonly string[] = [],
  imports: ActiveImportTargets | null = null,
): Promise<LinkTargetLookup & { readonly targets: LinkTargets }> {
  const targets = await loadLinkTargets(tx, chatBranchId);
  const byPath = new Map<string, string>();
  for (const p of targets.pages) byPath.set(normaliseLinkPath(p.path), p.id);
  const pageIds = new Set(targets.pages.map((p) => p.id));
  const bySlug = new Map(targets.media.map((m) => [m.slug, m.id]));
  const mediaIds = new Set(targets.media.map((m) => m.id));

  // An old URL that PERMANENTLY redirects to a page IS that page (a
  // rename left the 301 behind; links written with the old path mean the
  // page). A temporary redirect (302 / 307) says the old URL comes back,
  // so pinning a link to its current destination would be a guess.
  const redirects = (await tx.execute(sql`
    SELECT from_path, to_path FROM redirects WHERE status_code IN (301, 308)
  `)) as unknown as { from_path: string; to_path: string }[];
  const redirectTo = new Map(
    redirects.map((r) => [normaliseLinkPath(r.from_path), normaliseLinkPath(r.to_path)]),
  );

  const hosts = new Set<string>(
    [...extraOwnHosts, ...(imports?.sourceHosts ?? [])].map((h) => h.toLowerCase()),
  );
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
      const redirected = to === undefined ? undefined : byPath.get(to);
      if (redirected !== undefined) return redirected;
      // A planned page of the chat's import that is already rebuilt —
      // possibly under a translated slug — is the page its source path names.
      const rebuilt = imports?.rebuiltByPath.get(path);
      return rebuilt !== undefined && pageIds.has(rebuilt) ? rebuilt : null;
    },
    mediaIdForSlug: (slug) => bySlug.get(slug) ?? null,
    pageExists: (id) => pageIds.has(id),
    mediaExists: (id) => mediaIds.has(id),
    isOwnHost: (host) => hosts.has(host),
    ...(imports ? { isPendingPagePath: (path: string) => imports.runsByPath.has(path) } : {}),
  };
}

/** The outcome of canonicalising one write. */
export type CanonicaliseOutcome<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly issues: readonly LinkCanonicaliseIssue[];
      /**
       * Links kept literal because they point at a page the chat's import
       * run will still build; the op records them against the entity it
       * wrote ({@link recordPendingImportLinks}). Null = none.
       */
      readonly pending: PendingLinkRecord | null;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly issues: readonly LinkCanonicaliseIssue[];
    };

/**
 * Canonicalise one write's link-carrying input.
 *
 * @param apply runs the shared canonicalise functions against the run;
 *   pure — it runs once as a probe (see {@link probeLinkLookup}) and once
 *   more against the real lookup when the input carries a link.
 * @param opts.previous the stored state this write replaces; its link
 *   literals are grandfathered (see shared `link-canonicalise.ts`).
 * @param opts.mode `strict` refuses on any issue with an AI-actionable
 *   message; `report` (imports) keeps unresolved literals and returns
 *   them as issues.
 * @param opts.pendingEntity the write records links to its chat's
 *   planned import pages against an entity of this kind (see
 *   `import-targets.ts`). Only writes that can record — and whose entity
 *   the run's finalisation can rewrite — pass it; every other write
 *   refuses such a link like any unknown path.
 */
export async function canonicaliseLinksForWrite<T>(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  apply: (run: LinkCanonicaliseRun) => T,
  opts: {
    readonly previous?: unknown;
    readonly mode?: "strict" | "report";
    readonly pendingEntity?: ImportLinkEntityKind;
  } = {},
): Promise<CanonicaliseOutcome<T>> {
  const probe = probeLinkLookup(apply);
  if (!probe.needsLookup) return { ok: true, value: probe.value, issues: [], pending: null };
  const imports =
    opts.pendingEntity !== undefined && ctx.chatBranchId
      ? await loadActiveImportTargets(tx, ctx.chatBranchId)
      : null;
  const lookup = await loadLinkTargetLookup(tx, ctx.chatBranchId ?? null, [], imports);
  const run = linkCanonicaliseRun(lookup, {
    mode: opts.mode ?? "strict",
    grandfathered: opts.previous === undefined ? new Set() : collectLinkLiterals(opts.previous),
  });
  const value = apply(run);
  if (run.mode === "strict" && run.issues.length > 0) {
    return { ok: false, message: describeLinkIssues(run.issues), issues: run.issues };
  }
  return {
    ok: true,
    value,
    issues: run.issues,
    pending: imports && run.pending.length > 0 ? { targets: imports, pending: run.pending } : null,
  };
}
