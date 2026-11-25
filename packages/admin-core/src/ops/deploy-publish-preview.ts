// SPDX-License-Identifier: MPL-2.0

/**
 * `deploy.publish_preview` — what the next Publish live changes for
 * visitors: the pages that are new, changed or removed, the parts that
 * show on many pages, and the rendered settings. The Publish live review
 * in Live Edit shows it before the click; the redirects it ships come from
 * `redirects.release_plan`, as before.
 *
 * Read from what the builds already record (deploy/publish-preview.ts):
 * the two builds' render fingerprints, and the snapshot headers staged
 * between them (`site_snapshots.staged_at`, indexed by migration 0705).
 * "The live build" is the staging run the live production run was
 * promoted from (deploy.promote stamps its id into the production run's
 * `build_id`), so after a rollback the review compares with the build
 * that is live again.
 *
 * A section design or a section's content counts where it shows on main
 * (what the last Stage merged): on one published page as a change of that
 * page, on none not at all, on more as a site-wide part that says where
 * (ops/content/part-placement.ts, the rule the Draft changes summary uses).
 *
 * When the builds cannot be compared (nothing staged, a build from an
 * older release, live built directly by an Owner's production build), the
 * lists stay empty and `notice` says why: never a list that reads complete
 * but is not (CLAUDE.md §2).
 */

import {
  defineOperation,
  type TransactionRunner,
  textArray,
  uuidArray,
} from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  classifyRelease,
  type FingerprintChange,
  placedPartsOfRelease,
  type SiteWideChange,
  type StagedEntity,
  splitFingerprintKey,
} from "../deploy/publish-preview.js";
import { SITE_WIDE_WHAT } from "./chat/draft-summary.js";
import { loadPartPlacements, partKey, placementOf } from "./content/part-placement.js";
import { wherePartShows } from "./content/part-where.js";
import { renderedSettingLabel } from "./quality/render-fingerprint.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const pageItemSchema = z
  .object({ pageId: z.string(), title: z.string(), path: z.string().nullable() })
  .strict();
const pageGroupSchema = z
  .object({
    /** Every page of the group, exact. */
    total: z.number().int().nonnegative(),
    /** The first `limit` of them, by path. */
    items: z.array(pageItemSchema),
  })
  .strict();

const outputSchema = z.object({
  /** The staged build Publish live copies; null when nothing is staged. */
  staged: z
    .object({ runId: z.string(), startedAt: z.string(), finishedAt: z.string().nullable() })
    .nullable(),
  /** The live production build; null before the first Publish live. */
  live: z
    .object({
      runId: z.string(),
      finishedAt: z.string().nullable(),
      /** The staging run it was promoted from; null for an Owner's direct production build. */
      stagedRunId: z.string().nullable(),
    })
    .nullable(),
  /** Live already serves the staged build: Publish live has nothing to ship. */
  liveMatchesStaging: z.boolean(),
  /** Why the lists are empty or incomplete; null when they are exact. */
  notice: z.string().nullable(),
  pages: z.object({ new: pageGroupSchema, changed: pageGroupSchema, removed: pageGroupSchema }),
  /**
   * Parts that show on many pages: section designs and content shown on
   * more than one page (one shown on one page is a change of that page),
   * templates, layout, lists, theme, plugins.
   */
  siteWide: z.array(
    z
      .object({
        key: z.string(),
        kind: z.string(),
        change: z.enum(["new", "changed", "removed"]),
        title: z.string(),
        /** What it is, and where it shows: "Section design · on 4 pages". */
        what: z.string(),
        /** A published page that shows it, to look at on staging; null when none is named. */
        samplePath: z.string().nullable(),
      })
      .strict(),
  ),
  /** Rendered site settings and the security headers that change. */
  settings: z.array(z.object({ key: z.string(), title: z.string() }).strict()),
});

/** What `deploy.publish_preview` returns. */
export type PublishPreview = z.infer<typeof outputSchema>;

type RunRow = {
  id: string;
  build_id: string | null;
  started_at: string | Date;
  finished_at: string | Date | null;
  has_fingerprint: boolean;
};

const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: string | Date | null) => (v === null ? null : iso(v));
const emptyGroup = () => ({ total: 0, items: [] as z.infer<typeof pageItemSchema>[] });

export const publishPreviewOp = defineOperation({
  name: "deploy.publish_preview",
  // Why site-wide: what a Publish live changes is the difference between two
  // whole builds (their fingerprints hold every published page).
  readScope: "site",
  // CLAUDE.md §11: a read the AI may use to say what publishing would ship.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      fromTarget: z.string().min(1).max(80).default("staging"),
      toTarget: z.string().min(1).max(80).default("production"),
      /** Pages listed per group at most (new, changed, removed); the totals are exact. */
      limit: z.number().int().min(1).max(1000).default(200),
    })
    .strict(),
  output: outputSchema,
  handler: async (_ctx, input, tx) => {
    const targets = (await tx.execute(sql`
      SELECT id::text AS id, name FROM deploy_targets WHERE name IN (${input.fromTarget}, ${input.toTarget})
    `)) as unknown as { id: string; name: string }[];
    const from = targets.find((t) => t.name === input.fromTarget);
    const to = targets.find((t) => t.name === input.toTarget);
    if (!from || !to) {
      return err({
        kind: "HandlerError",
        operation: "deploy.publish_preview",
        message: `${!from ? input.fromTarget : input.toTarget} is not a deploy target of this install — list them with deploy.list_targets.`,
      });
    }

    const staged = await newestSucceeded(tx, from.id);
    const live = await newestSucceeded(tx, to.id);
    const base = {
      staged: staged
        ? {
            runId: staged.id,
            startedAt: iso(staged.started_at),
            finishedAt: isoOrNull(staged.finished_at),
          }
        : null,
      live: live
        ? {
            runId: live.id,
            finishedAt: isoOrNull(live.finished_at),
            stagedRunId: null as string | null,
          }
        : null,
      liveMatchesStaging: false,
      pages: { new: emptyGroup(), changed: emptyGroup(), removed: emptyGroup() },
      siteWide: [] as PublishPreview["siteWide"],
      settings: [] as PublishPreview["settings"],
    };
    const only = (notice: string) => ok({ ...base, notice });

    if (!staged)
      return only("Nothing is staged yet. Stage first: Publish live copies the staged build.");
    if (!staged.has_fingerprint) {
      return only(
        "This staged build was made by an older Caelo version, so what it changes cannot be listed. Stage again to see the list.",
      );
    }
    if (!live) {
      const pages = await publishedPages(tx, staged.id, input.limit);
      return ok({
        ...base,
        notice: "Nothing is live yet: every published page goes live with this first Publish live.",
        pages: { new: pages, changed: emptyGroup(), removed: emptyGroup() },
      });
    }

    // The staging run live was promoted from (its id is the production run's build id).
    const source =
      live.build_id && UUID_RE.test(live.build_id)
        ? (
            (await tx.execute(sql`
              SELECT id::text AS id, build_id, started_at, finished_at,
                     render_fingerprint IS NOT NULL AS has_fingerprint
                FROM deploy_runs WHERE id = ${live.build_id}::uuid AND target_id = ${from.id}::uuid
            `)) as unknown as RunRow[]
          )[0]
        : undefined;
    if (base.live && source) base.live.stagedRunId = source.id;
    if (!source) {
      return only(
        "The live site was built directly (an Owner's production build), so what this Publish live changes cannot be compared. It replaces live with this staged build.",
      );
    }
    if (source.id === staged.id) return ok({ ...base, liveMatchesStaging: true, notice: null });
    if (!source.has_fingerprint) {
      return only(
        "The live build was staged by an older Caelo version, so what this Publish live changes cannot be listed.",
      );
    }

    const fingerprint = await fingerprintDiff(tx, staged.id, source.id);
    // The live build started after the staged one (a rollback to a newer
    // build cannot happen; a Stage of an older run can): nothing was staged
    // in between, and Publish live would put older content live.
    const ordered = new Date(iso(source.started_at)) < new Date(iso(staged.started_at));
    const stagedEntities = ordered
      ? await stagedBetween(tx, iso(source.started_at), iso(staged.started_at))
      : [];
    // Where each changed section design and content shows on main, which
    // is what the last Stage merged.
    const parts = placedPartsOfRelease({ fingerprint, staged: stagedEntities });
    const placements = await loadPartPlacements(tx, null, parts);
    const publishedInStaged = await pagesInBuild(tx, staged.id, [
      ...new Set([
        ...stagedEntities.filter((e) => e.kind === "page").map((e) => e.id),
        ...[...placements.values()].flatMap((p) => p.pages.map((page) => page.pageId)),
      ]),
    ]);
    const where = new Map(
      parts.map((p) => [
        partKey(p),
        wherePartShows(placementOf(placements, p), (pageId) => publishedInStaged.has(pageId)),
      ]),
    );
    const release = classifyRelease({
      fingerprint,
      staged: stagedEntities,
      publishedInStaged,
      where,
    });
    // Main is what the last Stage merged. A later Stage whose build did not
    // finish (it failed, or still runs) merged on top of this build, so
    // where a section shows was read from that newer state: say so.
    const mainAdvanced = parts.length > 0 && (await stagedSince(tx, iso(staged.started_at)));

    return ok({
      ...base,
      notice: !ordered
        ? "The live build is newer than this staged build, so Publish live would put older content live. Stage again first."
        : mainAdvanced
          ? "A later Stage changed the site after this build and has not finished building, so where some sections show is read from that newer state. Stage again for an exact list."
          : null,
      pages: {
        new: await labelPages(tx, release.newPageIds, input.limit),
        changed: await labelPages(tx, release.changedPageIds, input.limit),
        removed: await labelPages(tx, release.removedPageIds, input.limit),
      },
      siteWide: await labelSiteWide(tx, release.siteWide),
      settings: [
        ...release.settings.flatMap((column) => {
          const label = renderedSettingLabel(column);
          return label ? [{ key: `setting:${column}`, title: capitalize(label) }] : [];
        }),
        ...((await securityHeadersDiffer(tx, staged.id, live.id))
          ? [{ key: "securityHeaders", title: "Security headers" }]
          : []),
      ],
    });
  },
});

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The newest succeeded build of a target. */
async function newestSucceeded(
  tx: TransactionRunner,
  targetId: string,
): Promise<RunRow | undefined> {
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, build_id, started_at, finished_at,
           render_fingerprint IS NOT NULL AS has_fingerprint
      FROM deploy_runs
     WHERE target_id = ${targetId}::uuid AND status = 'succeeded' AND build_id IS NOT NULL
     ORDER BY started_at DESC LIMIT 1
  `)) as unknown as RunRow[];
  return rows[0];
}

/** Fingerprint keys whose hash differs between the staged and the live build's source run. */
async function fingerprintDiff(
  tx: TransactionRunner,
  stagedRunId: string,
  liveRunId: string,
): Promise<FingerprintChange[]> {
  const rows = (await tx.execute(sql`
    WITH s AS (
      SELECT f.key, f.value FROM deploy_runs r CROSS JOIN LATERAL jsonb_each_text(r.render_fingerprint) f
       WHERE r.id = ${stagedRunId}::uuid
    ), l AS (
      SELECT f.key, f.value FROM deploy_runs r CROSS JOIN LATERAL jsonb_each_text(r.render_fingerprint) f
       WHERE r.id = ${liveRunId}::uuid
    )
    SELECT COALESCE(s.key, l.key) AS key,
           CASE WHEN l.key IS NULL THEN 'added' WHEN s.key IS NULL THEN 'removed' ELSE 'changed' END AS change
      FROM s FULL JOIN l ON l.key = s.key
     WHERE s.value IS DISTINCT FROM l.value
  `)) as unknown as { key: string; change: FingerprintChange["change"] }[];
  return rows.map((r) => ({ ...splitFingerprintKey(r.key), change: r.change }));
}

/**
 * The pages and site-wide parts staged in [from, to): the snapshot headers
 * a Stage merged after the live build started and before the staged one did.
 */
async function stagedBetween(
  tx: TransactionRunner,
  from: string,
  to: string,
): Promise<StagedEntity[]> {
  return (await tx.execute(sql`
    WITH h AS (
      SELECT ss.id FROM site_snapshots ss
       WHERE ss.staged_at >= ${from}::timestamptz AND ss.staged_at < ${to}::timestamptz
    )
    SELECT 'page' AS kind, x.page_id::text AS id FROM page_snapshots x JOIN h ON h.id = x.site_snapshot_id
    UNION SELECT 'page', x.page_id::text FROM page_layout_snapshots x JOIN h ON h.id = x.site_snapshot_id
    UNION SELECT 'page', x.page_id::text FROM page_module_content_snapshots x JOIN h ON h.id = x.site_snapshot_id
    UNION SELECT 'module', x.module_id::text FROM module_snapshots x JOIN h ON h.id = x.site_snapshot_id
    UNION SELECT 'template', x.template_id::text FROM template_snapshots x JOIN h ON h.id = x.site_snapshot_id
    UNION SELECT 'layout', x.layout_id::text FROM layout_module_snapshots x JOIN h ON h.id = x.site_snapshot_id
    UNION SELECT 'theme', x.theme_id::text FROM theme_snapshots x JOIN h ON h.id = x.site_snapshot_id
    UNION SELECT 'list', x.list_id::text FROM list_snapshots x JOIN h ON h.id = x.site_snapshot_id
    UNION SELECT 'listType', x.list_type_id::text FROM list_type_snapshots x JOIN h ON h.id = x.site_snapshot_id
    UNION SELECT 'pageType', x.page_type_id::text FROM page_type_snapshots x JOIN h ON h.id = x.site_snapshot_id
    UNION SELECT 'contentInstance', x.content_instance_id::text
            FROM content_instance_snapshots x JOIN h ON h.id = x.site_snapshot_id
    UNION SELECT 'pluginRow', x.plugin_id::text FROM plugin_row_snapshots x JOIN h ON h.id = x.site_snapshot_id
  `)) as unknown as StagedEntity[];
}

/** Whether a Stage merged anything at or after `from` (the staged build's start). */
async function stagedSince(tx: TransactionRunner, from: string): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT EXISTS (SELECT 1 FROM site_snapshots WHERE staged_at >= ${from}::timestamptz) AS advanced
  `)) as unknown as { advanced: boolean }[];
  return rows[0]?.advanced === true;
}

/**
 * Of `pageIds`, the pages the staged build publishes (its fingerprint has
 * them). The fingerprint's keys are expanded once and matched against the
 * ids: testing `?` once per id detoasts the whole fingerprint per id, which
 * took a second for 5,000 ids on a 5,000-page build.
 */
async function pagesInBuild(
  tx: TransactionRunner,
  runId: string,
  pageIds: readonly string[],
): Promise<Set<string>> {
  if (pageIds.length === 0) return new Set();
  const rows = (await tx.execute(sql`
    SELECT substring(k.key from 6) AS id
      FROM deploy_runs r CROSS JOIN LATERAL jsonb_object_keys(r.render_fingerprint) AS k(key)
     WHERE r.id = ${runId}::uuid AND k.key = ANY(${textArray(pageIds.map((id) => `page:${id}`))})
  `)) as unknown as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/** Every published page of a staged build: the first Publish live ships them all. */
async function publishedPages(
  tx: TransactionRunner,
  runId: string,
  limit: number,
): Promise<z.infer<typeof pageGroupSchema>> {
  const ids = (
    (await tx.execute(sql`
      SELECT substring(k.key from 6) AS id
        FROM deploy_runs r CROSS JOIN LATERAL jsonb_object_keys(r.render_fingerprint) AS k(key)
       WHERE r.id = ${runId}::uuid AND k.key LIKE 'page:%'
    `)) as unknown as { id: string }[]
  ).map((r) => r.id);
  return labelPages(tx, ids, limit);
}

/** The pages of one group, by path, at most `limit` of them; `total` counts them all. */
async function labelPages(
  tx: TransactionRunner,
  pageIds: readonly string[],
  limit: number,
): Promise<z.infer<typeof pageGroupSchema>> {
  if (pageIds.length === 0) return emptyGroup();
  const rows = (await tx.execute(sql`
    SELECT p.id::text AS page_id, COALESCE(p.title, p.slug) AS title, p.current_path AS path
      FROM pages p WHERE p.id = ANY(${uuidArray(pageIds)})
     ORDER BY p.current_path NULLS LAST, p.id
     LIMIT ${limit}
  `)) as unknown as { page_id: string; title: string; path: string | null }[];
  return {
    total: pageIds.length,
    items: rows.map((r) => ({ pageId: r.page_id, title: r.title, path: r.path })),
  };
}

/** What a fingerprinted plugin's change means for the operator. */
const PLUGIN_WHAT = {
  new: "Plugin turned on",
  changed: "Plugin updated",
  removed: "Plugin turned off",
} as const;

/** Names the site-wide parts, in the order the draft summary lists its kinds. */
async function labelSiteWide(
  tx: TransactionRunner,
  parts: readonly SiteWideChange[],
): Promise<PublishPreview["siteWide"]> {
  if (parts.length === 0) return [];
  const ids = uuidArray([...new Set(parts.map((p) => p.id))]);
  const rows = (await tx.execute(sql`
    SELECT 'module' AS kind, id::text AS id, display_name AS label FROM modules WHERE id = ANY(${ids})
    UNION ALL SELECT 'template', id::text, display_name FROM templates WHERE id = ANY(${ids})
    UNION ALL SELECT 'layout', id::text, display_name FROM layouts WHERE id = ANY(${ids})
    UNION ALL SELECT 'theme', id::text, COALESCE(display_name, slug) FROM themes WHERE id = ANY(${ids})
    UNION ALL SELECT 'plugin', id::text, slug FROM plugins WHERE id = ANY(${ids})
    UNION ALL SELECT 'list', id::text, COALESCE(name, slug) FROM lists WHERE id = ANY(${ids})
    UNION ALL SELECT 'listType', id::text, COALESCE(definition->>'name', slug) FROM list_types WHERE id = ANY(${ids})
    UNION ALL SELECT 'pageType', id::text, COALESCE(definition->>'name', slug) FROM page_types WHERE id = ANY(${ids})
    -- Every placement's own content is unnamed: its section design names it.
    UNION ALL SELECT 'contentInstance', ci.id::text, COALESCE(ci.display_name, ci.slug, m.display_name)
                FROM content_instances ci JOIN modules m ON m.id = ci.module_id
               WHERE ci.id = ANY(${ids})
  `)) as unknown as { kind: string; id: string; label: string | null }[];
  const label = new Map(rows.map((r) => [`${r.kind}:${r.id}`, r.label]));
  const order = Object.keys(SITE_WIDE_WHAT);
  const rank = (kind: string) => {
    const i = order.indexOf(kind === "plugin" ? "pluginRow" : kind);
    return i === -1 ? order.length : i;
  };
  return parts
    .map((p) => {
      // A plugin's data is labelled by its plugin.
      const named = label.get(`${p.kind === "pluginRow" ? "plugin" : p.kind}:${p.id}`);
      const what = p.kind === "plugin" ? PLUGIN_WHAT[p.change] : SITE_WIDE_WHAT[p.kind];
      if (what === undefined) {
        throw new Error(`deploy.publish_preview: no name for site-wide kind '${p.kind}'`);
      }
      return {
        key: `${p.kind}:${p.id}`,
        kind: p.kind,
        change: p.change,
        // A part deleted since has no row left to name it.
        title: named ?? "A deleted part",
        what: p.shows === null ? what : `${what} · ${p.shows}`,
        samplePath: p.samplePath,
      };
    })
    .sort((a, b) => rank(a.kind) - rank(b.kind) || a.title.localeCompare(b.title));
}

/**
 * Whether the staged build's security headers differ from what live serves
 * (#1454). A build from before #1454 recorded none, which says nothing
 * about a change, so only two recorded sets are compared.
 */
async function securityHeadersDiffer(
  tx: TransactionRunner,
  stagedRunId: string,
  liveRunId: string,
): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT s.security_headers IS NOT NULL AND l.security_headers IS NOT NULL
           AND s.security_headers <> l.security_headers AS differ
      FROM deploy_runs s, deploy_runs l
     WHERE s.id = ${stagedRunId}::uuid AND l.id = ${liveRunId}::uuid
  `)) as unknown as { differ: boolean }[];
  return rows[0]?.differ === true;
}
