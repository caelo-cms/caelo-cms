// SPDX-License-Identifier: MPL-2.0

/**
 * #1155 — the plugin-data build: plugin data reaches the static HTML
 * without publishing anything else.
 *
 * CMS_REQUIREMENTS §6.1 / §6.2. An approved item (a comment, say) is served
 * at once by the public API through the Web Component's delta fetch. This
 * build then bakes it into the HTML, so pages without JavaScript and
 * crawlers see it, and the delta feed's `since` (the bake's
 * `data-baked-at`) moves past it.
 *
 * What it renders from — the core guarantee. It does NOT run the generator
 * over cms_admin: `main` holds staged and live-written changes nobody
 * published, and drafts sit on the shared draft branch. It starts from the
 * FILES of the build that is live — the last succeeded production run
 * (a Publish live, a rollback, or an earlier plugin-data build) — read back
 * through the provider's publisher, and replaces only the marked bake
 * regions of plugins that declare baked data (static-generator
 * `bake-regions.ts`) with a fresh `staticRender` of current plugin data.
 * Every other byte, file, header, redirect and setting is the published
 * build's; the publisher releases exactly that tree. So it can carry no
 * page, module, template, theme, SEO, redirect or settings change a human
 * did not publish.
 *
 * Further limits, each refusing rather than guessing:
 *   - a region is refreshed only when the running plugin version rendered
 *     it, and only while the running Caelo version rendered the live
 *     build: a new plugin or Caelo release's markup goes live with the
 *     next Publish live, never on a data tick;
 *   - a plugin is re-rendered only while it runs (#1008): an active plugin
 *     that is not running here or on another live server keeps its marks
 *     pending; the other plugins' regions and assets are not touched, so
 *     their health does not matter to this build;
 *   - the live release must be the one the live run recorded (publisher).
 *
 * The quality gate (#553) does not apply. It audits a staged build before
 * a human publishes page structure; this build changes no structure — the
 * same plugin version renders the same markup into the region the audited
 * build already carried, with more or fewer data rows. Gating every
 * comment approval on a Lighthouse run would keep the item out of the
 * HTML for minutes per tick and spend an audit job on data, while what
 * the gate measures cannot change. The SEO gate does not apply either:
 * no `<head>` changes.
 *
 * Batching: one build per tick takes every pending mark (up to
 * {@link MAX_MARKS_PER_BUILD}), so many approvals in one tick produce one
 * build. It is a deploy run of its own kind (`build_kind = 'plugin_data'`,
 * `base_run_id` = the live run it built on), audited as
 * `deploy.build_plugin_data`. A tick with nothing to change publishes
 * nothing and records no run.
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { bakedDataPlugin, localBuildPluginServices } from "@caelo-cms/plugin-host";
import { defineOperation, execute, type TransactionRunner } from "@caelo-cms/query-api";
import { CAELO_VERSION, err, ok, PhaseTimer } from "@caelo-cms/shared";
import {
  bakeRegion,
  type DeployTarget,
  findBakeRegions,
  replaceBakeRegions,
} from "@caelo-cms/static-generator";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { describeError } from "../ai/tools/_describe-error.js";
import { recordAuditFromCtx, SYSTEM_ACTOR_ID } from "../audit.js";
import { holdDeployRun } from "../deploy/deploy-run-lock.js";
import { lockLiveReleases } from "../deploy/live-release-lock.js";
import { activePluginProblems } from "../deploy/plugin-problems.js";
import {
  type LiveBuildRef,
  loadStaticPublisher,
  type StaticPublisher,
} from "../deploy/static-publisher.js";
import { getDeployBridge, resolveOutputRoot } from "../ops/deploy.js";
import { uuidList } from "../ops/quality/_shared.js";
import { jsonbParam } from "../sql-helpers.js";

/** At most this many stale (plugin, page) marks are baked per build. */
export const MAX_MARKS_PER_BUILD = 2000;

/**
 * Older plugin-data archives kept per target besides the live one and the
 * new one (self-hosted keeps a full copy of the site per build); the next
 * plugin-data build drops the rest.
 */
export const PLUGIN_DATA_ARCHIVES_KEPT = 5;

/** Advisory lock: one plugin-data build at a time across every admin instance. */
const BUILD_LOCK_KEY = "caelo:plugin-data-build";

const outcomeSchema = z.enum([
  "not_due",
  "busy",
  "nothing_pending",
  "unchanged",
  "built",
  "blocked",
  "failed",
]);
export type PluginDataBuildOutcome = z.infer<typeof outcomeSchema>;

/** A plugin-data build cannot start from the live build as it is (not an error). */
class BlockedError extends Error {
  override readonly name = "BlockedError";
}

interface TargetRow {
  id: string;
  name: string;
  env: "dev" | "staging" | "production";
  out_dir: string;
  base_url: string;
  robots_default: "index" | "noindex";
  is_default: boolean;
  page_url_style: "directory" | "no-extension";
}

interface LiveRunRow {
  id: string;
  build_id: string;
  location: string | null;
  caelo_version: string | null;
}

/** A plugin whose stale bakes this build refreshes, and the pages it marks. */
interface RenderablePlugin {
  readonly id: string;
  readonly slug: string;
  readonly version: string;
  readonly pages: Set<string>;
}

/** What baking one target produced. */
interface TargetBake {
  readonly files: Map<string, Buffer>;
  /** (slug, pageId) bakes rewritten. */
  readonly bakedPages: number;
  /** Marked pages the live build does not contain. */
  readonly notLive: number;
  /** Regions left alone: another plugin version rendered them. */
  readonly versionMismatch: string[];
}

const routingManifestSchema = z.object({
  pages: z.array(
    z.object({
      pageId: z.string().uuid().optional(),
      outputPath: z.string().min(1),
    }),
  ),
});

function iso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function toDeployTarget(t: TargetRow): DeployTarget {
  return {
    id: t.id,
    name: t.name,
    env: t.env,
    outDir: t.out_dir,
    baseUrl: t.base_url,
    robotsDefault: t.robots_default,
    pageUrlStyle: t.page_url_style ?? "directory",
  };
}

/**
 * Bake one target: read the live build's routing manifest and the files of
 * the marked pages, re-render the marked regions, return the files that
 * changed. Pure file work plus `staticRender` — no write anywhere.
 */
async function bakeTarget(args: {
  publisher: StaticPublisher;
  target: DeployTarget;
  live: LiveBuildRef;
  plugins: readonly RenderablePlugin[];
  bakedAt: string;
}): Promise<TargetBake> {
  const { publisher, target, live, plugins, bakedAt } = args;
  const manifestRaw = (
    await publisher.readLiveFiles({ target, live, paths: ["routing-manifest.json"] })
  ).get("routing-manifest.json");
  if (!manifestRaw) {
    throw new BlockedError(
      `the live build of "${target.name}" has no routing-manifest.json, so its pages cannot be found. Publish live again.`,
    );
  }
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestRaw.toString("utf8"));
  } catch (e) {
    throw new BlockedError(
      `the live build's routing-manifest.json is not JSON (${e instanceof Error ? e.message : String(e)}). Publish live again.`,
    );
  }
  const manifest = routingManifestSchema.safeParse(manifestJson);
  if (!manifest.success) {
    throw new BlockedError(
      `the live build's routing-manifest.json lists no pages Caelo can read (${manifest.error.issues[0]?.message ?? "invalid"}). Publish live again.`,
    );
  }
  const pathOf = new Map<string, string>();
  for (const p of manifest.data.pages) if (p.pageId) pathOf.set(p.pageId, p.outputPath);
  if (pathOf.size === 0 && manifest.data.pages.length > 0) {
    throw new BlockedError(
      "the live build was published before plugin-data builds existed (its routing manifest names no page ids). Plugin data reaches the HTML with the next Publish live; until then the delta feed serves it.",
    );
  }

  const wantedByPath = new Map<string, Set<string>>();
  let notLive = 0;
  for (const plugin of plugins) {
    for (const pageId of plugin.pages) {
      const path = pathOf.get(pageId);
      if (!path) {
        notLive += 1;
        continue;
      }
      const set = wantedByPath.get(path) ?? new Set<string>();
      set.add(`${plugin.slug}:${pageId}`);
      wantedByPath.set(path, set);
    }
  }
  const files = await publisher.readLiveFiles({ target, live, paths: [...wantedByPath.keys()] });
  const bySlug = new Map(plugins.map((p) => [p.slug, p]));

  // Render each wanted (plugin, page) once, only where a region exists.
  const renders = new Map<string, string>();
  const versionMismatch = new Set<string>();
  for (const [path, wanted] of wantedByPath) {
    const body = files.get(path);
    if (!body) {
      notLive += wanted.size;
      continue;
    }
    for (const region of findBakeRegions(body.toString("utf8"))) {
      const key = `${region.slug}:${region.pageId}`;
      if (!wanted.has(key) || renders.has(key)) continue;
      const plugin = bySlug.get(region.slug);
      if (!plugin) continue;
      if (region.version !== plugin.version) {
        versionMismatch.add(`${region.slug}@${region.version}`);
        continue;
      }
      // A failing render fails the build (CLAUDE.md §2): an empty region
      // would remove the published items from the page.
      renders.set(
        key,
        await localBuildPluginServices.staticRender(
          region.slug,
          region.pageId,
          target.pageUrlStyle ?? "directory",
        ),
      );
    }
  }

  const changed = new Map<string, Buffer>();
  const baked = new Set<string>();
  for (const [path] of wantedByPath) {
    const body = files.get(path);
    if (!body) continue;
    const html = body.toString("utf8");
    const next = replaceBakeRegions(html, (region) => {
      const key = `${region.slug}:${region.pageId}`;
      const rendered = renders.get(key);
      if (rendered === undefined) return null;
      const plugin = bySlug.get(region.slug);
      if (!plugin) return null;
      // Same data as baked: keep the bytes (and the older `since`).
      const same = bakeRegion({
        slug: region.slug,
        pageId: region.pageId,
        version: region.version,
        bakedAt: region.bakedAt ?? "",
        html: rendered,
      });
      if (same === region.text) return null;
      baked.add(key);
      return bakeRegion({
        slug: region.slug,
        pageId: region.pageId,
        version: plugin.version,
        bakedAt,
        html: rendered,
      });
    });
    if (next !== html) changed.set(path, Buffer.from(next, "utf8"));
  }
  return {
    files: changed,
    bakedPages: baked.size,
    notLive,
    versionMismatch: [...versionMismatch].sort(),
  };
}

async function recordState(
  tx: TransactionRunner,
  outcome: Exclude<PluginDataBuildOutcome, "not_due" | "busy">,
  message: string | null,
): Promise<void> {
  await tx.execute(sql`
    UPDATE plugin_data_build_state
       SET last_tick_at = clock_timestamp(), last_outcome = ${outcome},
           last_message = ${message === null ? null : message.slice(0, 4000)}
     WHERE id = 1
  `);
}

const buildOutput = z.object({
  outcome: outcomeSchema,
  /** The plugin-data deploy runs this build recorded (one per production target). */
  runIds: z.array(z.string()),
  /** Why it did not build, or which plugins wait; null when there is nothing to say. */
  message: z.string().nullable(),
  /** (plugin, page) bakes rewritten. */
  bakedPages: z.number().int(),
  /** Files replaced in the live build. */
  changedFiles: z.number().int(),
});
type BuildOutput = z.infer<typeof buildOutput>;

export const buildPluginDataOp = defineOperation({
  name: "deploy.build_plugin_data",
  // Why human-only: the plugin-data tick (plugin-data/worker.ts) runs it as
  // the system actor; it carries no decision — it republishes the build a
  // human published, with fresher data in plugin-owned regions only. No AI
  // tool: there is nothing for the AI to choose.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      /** Skip when the previous tick (any instance) ran this recently. */
      minIntervalSeconds: z.number().int().min(0).max(3600).default(240),
      /** At most this many stale (plugin, page) marks per build (tests lower it). */
      maxMarks: z.number().int().min(1).max(MAX_MARKS_PER_BUILD).default(MAX_MARKS_PER_BUILD),
      /** Tests: the root relative `deploy_targets.out_dir` values resolve against. */
      repoRoot: z.string().optional(),
    })
    .strict(),
  output: buildOutput,
  handler: async (ctx, input, tx) => {
    const timer = new PhaseTimer();
    const result = (
      outcome: PluginDataBuildOutcome,
      message: string | null,
      extra: Partial<BuildOutput> = {},
    ): BuildOutput => ({
      outcome,
      message,
      runIds: [],
      bakedPages: 0,
      changedFiles: 0,
      ...extra,
    });

    const locked = (await tx.execute(sql`
      SELECT pg_try_advisory_xact_lock(hashtext(${BUILD_LOCK_KEY})) AS ok
    `)) as unknown as { ok: boolean }[];
    if (locked[0]?.ok !== true) {
      return ok(result("busy", "another plugin-data build is running"));
    }
    const due = (await tx.execute(sql`
      SELECT last_tick_at IS NULL
          OR last_tick_at < clock_timestamp() - make_interval(secs => ${input.minIntervalSeconds})
          AS due
      FROM plugin_data_build_state WHERE id = 1
    `)) as unknown as { due: boolean }[];
    if (due.length === 0) {
      throw new Error("plugin_data_build_state has no row — run the database migrations (0371)");
    }
    if (due[0]?.due !== true) return ok(result("not_due", null));

    // Which plugins have stale bakes — eligibility is decided per plugin
    // BEFORE the batch is limited, so the marks of a plugin that cannot
    // render now never take the whole batch from the ones that can.
    const pendingPlugins = (await tx.execute(sql`
      SELECT DISTINCT plugin_id::text AS plugin_id
      FROM plugin_data_stale_pages
      WHERE baked_through IS NULL OR last_marked_at > baked_through
    `)) as unknown as { plugin_id: string }[];
    if (pendingPlugins.length === 0) {
      await recordState(tx, "nothing_pending", null);
      return ok(result("nothing_pending", null));
    }

    let markCount = 0;
    const finish = async (
      outcome: "unchanged" | "built" | "blocked" | "failed",
      message: string | null,
      extra: Partial<BuildOutput> = {},
    ): Promise<BuildOutput> => {
      await recordState(tx, outcome, message);
      await recordAuditFromCtx(tx, ctx, {
        operation: "deploy.build_plugin_data",
        input: { pendingPlugins: pendingPlugins.length, marks: markCount },
        succeeded: outcome === "unchanged" || outcome === "built",
        entityId: extra.runIds?.[0] ?? null,
        resultSummary: outcome,
      });
      return result(outcome, message, extra);
    };

    const targets = (await tx.execute(sql`
      SELECT id::text AS id, name, env, out_dir, base_url, robots_default, is_default, page_url_style
      FROM deploy_targets WHERE env = 'production' ORDER BY is_default DESC, name
    `)) as unknown as TargetRow[];
    if (targets.length === 0) {
      return ok(await finish("blocked", "no production deploy target is configured"));
    }

    // Ordered with every other write to the live site (Publish live,
    // rollback, the CDN purge): what is live cannot change under this build.
    await lockLiveReleases(tx);
    timer.lap("lock-wait");

    // #1008 — re-render only plugins that run; their marks wait otherwise.
    const problems = new Map((await activePluginProblems(tx)).map((p) => [p.slug, p.reason]));
    const eligible = new Map<string, Omit<RenderablePlugin, "pages">>();
    const waiting: string[] = [];
    for (const { plugin_id: pluginId } of pendingPlugins) {
      const plugin = bakedDataPlugin(pluginId);
      if (!plugin) {
        waiting.push(`plugin ${pluginId} (not running on this server, or declares no baked data)`);
        continue;
      }
      const problem = problems.get(plugin.slug);
      if (problem) {
        waiting.push(`"${plugin.slug}" (${problem})`);
        continue;
      }
      eligible.set(pluginId, plugin);
    }
    const waitingNote =
      waiting.length > 0
        ? `Waiting for ${waiting.join("; ")} — their pages are baked once they run.`
        : null;
    if (eligible.size === 0) {
      return ok(await finish("blocked", waitingNote));
    }

    const pending = (await tx.execute(sql`
      SELECT plugin_id::text AS plugin_id, page_id::text AS page_id
      FROM plugin_data_stale_pages
      WHERE (baked_through IS NULL OR last_marked_at > baked_through)
        AND plugin_id = ANY(${uuidList([...eligible.keys()])})
      ORDER BY last_marked_at
      LIMIT ${input.maxMarks}
    `)) as unknown as { plugin_id: string; page_id: string }[];
    markCount = pending.length;
    const byPlugin = new Map<string, Set<string>>();
    for (const row of pending) {
      const set = byPlugin.get(row.plugin_id) ?? new Set<string>();
      set.add(row.page_id);
      byPlugin.set(row.plugin_id, set);
    }
    const renderable: RenderablePlugin[] = [];
    for (const [pluginId, pages] of byPlugin) {
      const plugin = eligible.get(pluginId);
      if (plugin) renderable.push({ ...plugin, pages });
    }

    // The bake's `data-baked-at`: the database clock BEFORE any plugin data
    // is read, so whatever lands while the build renders stays in the
    // delta feed instead of falling between the HTML and the feed.
    const clock = (await tx.execute(sql`SELECT clock_timestamp() AS at`)) as unknown as {
      at: string | Date;
    }[];
    const dataAsOf = clock[0]?.at;
    if (dataAsOf === undefined) throw new Error("clock_timestamp() returned no row");
    const bakedAt = iso(dataAsOf);
    timer.lap("prepare");

    const publisher = await loadStaticPublisher(process.env.CAELO_PROVIDER);
    const root = resolveOutputRoot(input.repoRoot);
    const runIds: string[] = [];
    let bakedPages = 0;
    let changedFiles = 0;
    const notes: string[] = [];
    for (const t of targets) {
      const liveRows = (await tx.execute(sql`
        SELECT id::text AS id, build_id, publish_summary->>'location' AS location, caelo_version
        FROM deploy_runs
        WHERE target_id = ${t.id}::uuid AND status = 'succeeded' AND build_id IS NOT NULL
        ORDER BY finished_at DESC NULLS LAST, started_at DESC
        LIMIT 1
      `)) as unknown as LiveRunRow[];
      const liveRow = liveRows[0];
      if (!liveRow) {
        return ok(
          await finish(
            "blocked",
            `nothing is published on "${t.name}" yet — plugin data is baked with the first Publish live`,
          ),
        );
      }
      if (liveRow.caelo_version !== CAELO_VERSION) {
        return ok(
          await finish(
            "blocked",
            `the live build of "${t.name}" was rendered by Caelo ${liveRow.caelo_version ?? "(unknown)"}, this server runs ${CAELO_VERSION}. Plugin data reaches the HTML with the next Publish live (a new release's markup never goes live on a data tick); until then the delta feed serves it.`,
          ),
        );
      }
      const target = toDeployTarget(t);
      const live: LiveBuildRef = {
        runId: liveRow.id,
        buildId: liveRow.build_id,
        location: liveRow.location,
        localBuildDir: resolve(root, t.out_dir, "builds", liveRow.build_id),
      };
      let bake: TargetBake;
      try {
        bake = await bakeTarget({ publisher, target, live, plugins: renderable, bakedAt });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (e instanceof BlockedError) return ok(await finish("blocked", message));
        await finish("failed", `could not bake "${t.name}": ${message}`);
        return err({
          kind: "HandlerError",
          operation: "deploy.build_plugin_data",
          message: `could not bake "${t.name}": ${message}`,
        });
      }
      timer.lap(`bake:${t.name}`);
      if (bake.versionMismatch.length > 0) {
        notes.push(
          `On "${t.name}" ${bake.versionMismatch.join(", ")} rendered the live regions; the running version's markup goes live with the next Publish live.`,
        );
      }
      if (bake.files.size === 0) continue;

      const bridge = getDeployBridge();
      if (!bridge) throw new Error("deploy-bridge not configured");
      const runId = randomUUID();
      await holdDeployRun(tx, runId);
      const begun = await execute(
        bridge.registry,
        bridge.adapter,
        { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: ctx.requestId },
        "deploy.begin_run",
        {
          runId,
          targetId: t.id,
          actorId: ctx.actorId,
          startedAt: bakedAt,
          renderFingerprint: null,
          caeloVersion: liveRow.caelo_version,
          pluginProblems: null,
          buildKind: "plugin_data",
          baseRunId: liveRow.id,
        },
      );
      if (!begun.ok) {
        const message = `could not start the plugin-data run: ${describeError(begun.error)}`;
        await finish("failed", message);
        return err({ kind: "HandlerError", operation: "deploy.build_plugin_data", message });
      }
      const summaryOfBake = {
        bakedPages: bake.bakedPages,
        notLive: bake.notLive,
        versionMismatch: bake.versionMismatch,
        plugins: renderable.map((p) => ({ slug: p.slug, version: p.version, pages: p.pages.size })),
        dataAsOf: bakedAt,
      };
      // The live build (which may itself be one) is never dropped.
      const older = (await tx.execute(sql`
        SELECT build_id FROM deploy_runs
        WHERE target_id = ${t.id}::uuid AND build_kind = 'plugin_data' AND status = 'succeeded'
          AND build_id IS NOT NULL AND build_id <> ${liveRow.build_id}
        ORDER BY finished_at DESC NULLS LAST, started_at DESC
        OFFSET ${PLUGIN_DATA_ARCHIVES_KEPT}
      `)) as unknown as { build_id: string }[];
      try {
        const summary = await publisher.publishPluginData({
          target,
          live,
          runId,
          files: bake.files,
          pruneBuildIds: older.map((r) => r.build_id),
        });
        timer.lap(`publish:${t.name}`);
        await tx.execute(sql`
          UPDATE deploy_runs
             SET status = 'succeeded', finished_at = clock_timestamp(),
                 page_count = ${bake.bakedPages}, file_count = ${bake.files.size},
                 build_id = ${summary.destinationBuildId},
                 publish_summary = ${jsonbParam(summary)},
                 plugin_data = ${jsonbParam(summaryOfBake)},
                 phase_timings = ${jsonbParam(timer.phases())}
           WHERE id = ${runId}::uuid
        `);
      } catch (e) {
        const message = `publishing plugin data failed: ${e instanceof Error ? e.message : String(e)}`;
        await tx.execute(sql`
          UPDATE deploy_runs
             SET status = 'failed', finished_at = clock_timestamp(), error_message = ${message},
                 plugin_data = ${jsonbParam(summaryOfBake)},
                 phase_timings = ${jsonbParam(timer.phases())}
           WHERE id = ${runId}::uuid
        `);
        await finish("failed", message, { runIds: [runId] });
        return err({ kind: "HandlerError", operation: "deploy.build_plugin_data", message });
      }
      runIds.push(runId);
      bakedPages += bake.bakedPages;
      changedFiles += bake.files.size;
    }

    // Every target now carries the data read at `dataAsOf` for the pages
    // of the plugins that rendered (or had nothing new). A mark that came
    // in after that instant stays pending.
    for (const plugin of renderable) {
      await tx.execute(sql`
        UPDATE plugin_data_stale_pages
           SET baked_through = ${bakedAt}::timestamptz,
               last_run_id = ${runIds.at(-1) ?? null}
         WHERE plugin_id = ${plugin.id}::uuid
           AND page_id = ANY(${uuidList([...plugin.pages])})
      `);
    }
    const message = [waitingNote, ...notes].filter((m): m is string => m !== null).join(" ");
    console.info(
      `[plugin-data] ${runIds.length > 0 ? "built" : "unchanged"} in ${timer.totalMs()} ms`,
      JSON.stringify({ runIds, bakedPages, changedFiles, phases: timer.phases() }),
    );
    return ok(
      await finish(runIds.length > 0 ? "built" : "unchanged", message.length > 0 ? message : null, {
        runIds,
        bakedPages,
        changedFiles,
      }),
    );
  },
});
