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
 *
 * #1220 — the build holds NO database transaction while it renders and
 * uploads. It is a step-wise op, like Stage and Publish live (#1211,
 * #1225); every database step is a short op of its own:
 *
 *   deploy.start_plugin_data       claim the tick, pick the marks and the
 *                                  live build per target
 *   (bake)                         read the live files, render the regions
 *   deploy.begin_plugin_data_run   the run row with its lease + the
 *                                  live-release lease, only while the live
 *                                  build is still the one baked from
 *   deploy.renew_run_lease         the fence right before the release
 *   (publishPluginData)            no transaction
 *   deploy.finish_plugin_data_run  record the run, release the lease
 *   redirects.sync_provider        push the redirects
 *   deploy.finish_plugin_data_tick mark what was baked, record the outcome
 *
 * While Publish live, a rollback or a CDN purge holds the live release the
 * tick SKIPS (`busy`) instead of waiting: its marks stay pending, and the
 * next tick bakes them. One tick at a time across every admin instance:
 * the start step claims the tick (`plugin_data_build_state.last_tick_at`).
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { bakedDataPlugin, localBuildPluginServices } from "@caelo-cms/plugin-host";
import {
  defineOperation,
  defineStepwiseOperation,
  execute,
  type OperationSteps,
  type QueryError,
  type TransactionRunner,
} from "@caelo-cms/query-api";
import {
  CAELO_VERSION,
  type ExecutionContext,
  err,
  ok,
  PhaseTimer,
  phaseTimingSchema,
  type Result,
} from "@caelo-cms/shared";
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
import {
  DEPLOY_RUN_HEARTBEAT_MS,
  DEPLOY_RUN_LEASE_TTL_MS,
  type DeployRunBeat,
  DeployRunHeartbeat,
} from "../deploy/deploy-run-lock.js";
import {
  acquireLiveRelease,
  releaseLiveRelease,
  tryLockLiveRelease,
} from "../deploy/live-release-lock.js";
import { resolveOutputRoot } from "../deploy/output-root.js";
import { activePluginProblems } from "../deploy/plugin-problems.js";
import { markRedirectsBehind } from "../deploy/redirect-sync.js";
import {
  type LiveBuildRef,
  loadStaticPublisher,
  type StaticPublisher,
} from "../deploy/static-publisher.js";
import { fenceRunLeases } from "../ops/deploy-lease-steps.js";
import { beginRunInTx } from "../ops/deploy-run-lifecycle.js";
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

function result(
  outcome: PluginDataBuildOutcome,
  message: string | null,
  extra: Partial<BuildOutput> = {},
): BuildOutput {
  return { outcome, message, runIds: [], bakedPages: 0, changedFiles: 0, ...extra };
}

const outcomeRecord = z
  .object({
    outcome: z.enum(["unchanged", "built", "blocked", "failed"]),
    message: z.string().nullable(),
    pendingPlugins: z.number().int(),
    marks: z.number().int(),
    runIds: z.array(z.string()),
  })
  .strict();

/** Record a tick's outcome (state row + audit) in the caller's transaction. */
async function recordOutcome(
  tx: TransactionRunner,
  ctx: Parameters<typeof recordAuditFromCtx>[1],
  o: z.infer<typeof outcomeRecord>,
): Promise<void> {
  await recordState(tx, o.outcome, o.message);
  await recordAuditFromCtx(tx, ctx, {
    operation: "deploy.build_plugin_data",
    input: { pendingPlugins: o.pendingPlugins, marks: o.marks },
    succeeded: o.outcome === "unchanged" || o.outcome === "built",
    entityId: o.runIds[0] ?? null,
    resultSummary: o.outcome,
  });
}

const liveTarget = z.object({
  target: z.object({
    id: z.string(),
    name: z.string(),
    env: z.enum(["dev", "staging", "production"]),
    outDir: z.string(),
    baseUrl: z.string(),
    robotsDefault: z.enum(["index", "noindex"]),
    pageUrlStyle: z.enum(["directory", "no-extension"]),
  }),
  liveRunId: z.string(),
  liveBuildId: z.string(),
  liveLocation: z.string().nullable(),
  liveCaeloVersion: z.string(),
});

/** What deploy.start_plugin_data hands the build. */
const pluginDataPlan = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("done"), result: buildOutput }),
  z.object({
    kind: z.literal("bake"),
    /** The bake's `data-baked-at` (see the start step). */
    bakedAt: z.string(),
    plugins: z.array(
      z.object({
        id: z.string(),
        slug: z.string(),
        version: z.string(),
        pages: z.array(z.string()),
      }),
    ),
    targets: z.array(liveTarget),
    waitingNote: z.string().nullable(),
    pendingPlugins: z.number().int(),
    marks: z.number().int(),
  }),
]);
type PluginDataPlan = z.infer<typeof pluginDataPlan>;

const buildInput = z
  .object({
    /** Skip when the previous tick (any instance) ran this recently. */
    minIntervalSeconds: z.number().int().min(0).max(3600).default(240),
    /** At most this many stale (plugin, page) marks per build (tests lower it). */
    maxMarks: z.number().int().min(1).max(MAX_MARKS_PER_BUILD).default(MAX_MARKS_PER_BUILD),
    /** Tests: the root relative `deploy_targets.out_dir` values resolve against. */
    repoRoot: z.string().optional(),
  })
  .strict();

export const startPluginDataOp = defineOperation({
  name: "deploy.start_plugin_data",
  // Why system-only: the first step of deploy.build_plugin_data (the
  // plugin-data tick, system actor); it decides nothing of its own.
  actorScope: ["system"],
  database: "cms_admin",
  input: buildInput.omit({ repoRoot: true }),
  output: pluginDataPlan,
  handler: async (ctx, input, tx) => {
    // The tick is claimed here, so a tick of another instance in the same
    // window finds it not due: one plugin-data build at a time. A tick
    // that dies mid-build only delays the next by `minIntervalSeconds`.
    const claimed = (await tx.execute(sql`
      UPDATE plugin_data_build_state SET last_tick_at = clock_timestamp()
      WHERE id = 1
        AND (last_tick_at IS NULL
             OR last_tick_at < clock_timestamp() - make_interval(secs => ${input.minIntervalSeconds}))
      RETURNING 1 AS claimed
    `)) as unknown as { claimed: number }[];
    if (claimed.length === 0) {
      const exists = (await tx.execute(sql`
        SELECT 1 AS present FROM plugin_data_build_state WHERE id = 1
      `)) as unknown as { present: number }[];
      if (exists.length === 0) {
        throw new Error("plugin_data_build_state has no row — run the database migrations (0371)");
      }
      return ok({ kind: "done" as const, result: result("not_due", null) });
    }

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
      return ok({ kind: "done" as const, result: result("nothing_pending", null) });
    }
    const done = async (outcome: "blocked", message: string | null, marks = 0) => {
      await recordOutcome(tx, ctx, {
        outcome,
        message,
        pendingPlugins: pendingPlugins.length,
        marks,
        runIds: [],
      });
      return ok({ kind: "done" as const, result: result(outcome, message) });
    };

    const targets = (await tx.execute(sql`
      SELECT id::text AS id, name, env, out_dir, base_url, robots_default, is_default, page_url_style
      FROM deploy_targets WHERE env = 'production' ORDER BY is_default DESC, name
    `)) as unknown as TargetRow[];
    if (targets.length === 0) return done("blocked", "no production deploy target is configured");

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
    if (eligible.size === 0) return done("blocked", waitingNote);

    const pending = (await tx.execute(sql`
      SELECT plugin_id::text AS plugin_id, page_id::text AS page_id
      FROM plugin_data_stale_pages
      WHERE (baked_through IS NULL OR last_marked_at > baked_through)
        AND plugin_id = ANY(${uuidList([...eligible.keys()])})
      ORDER BY last_marked_at
      LIMIT ${input.maxMarks}
    `)) as unknown as { plugin_id: string; page_id: string }[];
    const byPlugin = new Map<string, Set<string>>();
    for (const row of pending) {
      const set = byPlugin.get(row.plugin_id) ?? new Set<string>();
      set.add(row.page_id);
      byPlugin.set(row.plugin_id, set);
    }
    const plugins: { id: string; slug: string; version: string; pages: string[] }[] = [];
    for (const [pluginId, pages] of byPlugin) {
      const plugin = eligible.get(pluginId);
      if (plugin) plugins.push({ ...plugin, pages: [...pages] });
    }

    // The bake's `data-baked-at`: the database clock BEFORE any plugin data
    // is read, so whatever lands while the build renders stays in the
    // delta feed instead of falling between the HTML and the feed.
    const clock = (await tx.execute(sql`SELECT clock_timestamp() AS at`)) as unknown as {
      at: string | Date;
    }[];
    const dataAsOf = clock[0]?.at;
    if (dataAsOf === undefined) throw new Error("clock_timestamp() returned no row");

    const live: z.infer<typeof liveTarget>[] = [];
    for (const t of targets) {
      const liveRow = await liveRunOf(tx, t.id);
      if (!liveRow) {
        return done(
          "blocked",
          `nothing is published on "${t.name}" yet — plugin data is baked with the first Publish live`,
          pending.length,
        );
      }
      if (liveRow.caelo_version !== CAELO_VERSION) {
        return done(
          "blocked",
          `the live build of "${t.name}" was rendered by Caelo ${liveRow.caelo_version ?? "(unknown)"}, this server runs ${CAELO_VERSION}. Plugin data reaches the HTML with the next Publish live (a new release's markup never goes live on a data tick); until then the delta feed serves it.`,
          pending.length,
        );
      }
      live.push({
        target: toDeployTarget(t) as z.infer<typeof liveTarget>["target"],
        liveRunId: liveRow.id,
        liveBuildId: liveRow.build_id,
        liveLocation: liveRow.location,
        liveCaeloVersion: liveRow.caelo_version,
      });
    }
    return ok({
      kind: "bake" as const,
      bakedAt: iso(dataAsOf),
      plugins,
      targets: live,
      waitingNote,
      pendingPlugins: pendingPlugins.length,
      marks: pending.length,
    });
  },
});

/** The build a target serves: its last succeeded run (any kind). */
async function liveRunOf(tx: TransactionRunner, targetId: string): Promise<LiveRunRow | null> {
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, build_id, publish_summary->>'location' AS location, caelo_version
    FROM deploy_runs
    WHERE target_id = ${targetId}::uuid AND status = 'succeeded' AND build_id IS NOT NULL
    ORDER BY finished_at DESC NULLS LAST, started_at DESC
    LIMIT 1
  `)) as unknown as LiveRunRow[];
  return rows[0] ?? null;
}

/** The live-release lease was busy (or the live build moved); the savepoint rolls back. */
class LiveReleaseBusy extends Error {
  override readonly name = "LiveReleaseBusy";
  constructor(readonly reason: string) {
    super(reason);
  }
}

export const beginPluginDataRunOp = defineOperation({
  name: "deploy.begin_plugin_data_run",
  // Why system-only: a step of deploy.build_plugin_data (system actor).
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      runId: z.string().uuid(),
      targetId: z.string().uuid(),
      liveRunId: z.string().uuid(),
      caeloVersion: z.string(),
      startedAt: z.string(),
      leaseTtlMs: z.number().int().min(1_000).max(3_600_000),
    })
    .strict(),
  output: z.discriminatedUnion("started", [
    z.object({
      started: z.literal(true),
      /** Older plugin-data archives the publisher may drop (never the live one). */
      pruneBuildIds: z.array(z.string()),
    }),
    z.object({ started: z.literal(false), reason: z.string() }),
  ]),
  handler: async (ctx, input, tx) => {
    try {
      // A savepoint: a busy lease leaves no run row behind (a tick that
      // publishes nothing records no run).
      await tx.transaction(async (sp) => {
        await beginRunInTx(sp as TransactionRunner, {
          runId: input.runId,
          targetId: input.targetId,
          actorId: ctx.actorId,
          startedAt: input.startedAt,
          renderFingerprint: null,
          caeloVersion: input.caeloVersion,
          pluginProblems: null,
          buildKind: "plugin_data",
          baseRunId: input.liveRunId,
          leaseTtlMs: input.leaseTtlMs,
        });
        const lease = await acquireLiveRelease(sp as TransactionRunner, {
          runId: input.runId,
          ttlMs: input.leaseTtlMs,
        });
        if (!lease.acquired) {
          throw new LiveReleaseBusy(
            `${lease.heldBy ? `run ${lease.heldBy.runId}` : "a rollback, CDN purge or a release of the previous Caelo version"} is releasing the live site right now; the marks stay pending for the next tick`,
          );
        }
        // What is live cannot have changed since the bake read it: Publish
        // live, a rollback or another plugin-data build would have moved it.
        // Checked with the lease held (a release that committed before the
        // claim is seen here; none can start after it), so the files baked
        // from the live build never replace a newer one (review on #1251).
        const liveNow = await liveRunOf(sp as TransactionRunner, input.targetId);
        if (liveNow?.id !== input.liveRunId) {
          throw new LiveReleaseBusy(
            "the live build changed while plugin data was baked; the marks stay pending for the next tick",
          );
        }
      });
    } catch (e) {
      if (e instanceof LiveReleaseBusy) return ok({ started: false as const, reason: e.reason });
      throw e;
    }
    // The live build (which may itself be one) is never dropped.
    const older = (await tx.execute(sql`
      SELECT build_id FROM deploy_runs
      WHERE target_id = ${input.targetId}::uuid AND build_kind = 'plugin_data'
        AND status = 'succeeded' AND build_id IS NOT NULL
        AND id <> ${input.liveRunId}::uuid
      ORDER BY finished_at DESC NULLS LAST, started_at DESC
      OFFSET ${PLUGIN_DATA_ARCHIVES_KEPT}
    `)) as unknown as { build_id: string }[];
    return ok({ started: true as const, pruneBuildIds: older.map((r) => r.build_id) });
  },
});

export const finishPluginDataRunOp = defineOperation({
  name: "deploy.finish_plugin_data_run",
  // Why system-only: a step of deploy.build_plugin_data (system actor).
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      runId: z.string().uuid(),
      targetId: z.string().uuid(),
      pageCount: z.number().int(),
      fileCount: z.number().int(),
      buildId: z.string(),
      publishSummary: z.record(z.string(), z.unknown()),
      pluginData: z.record(z.string(), z.unknown()),
      phaseTimings: z.array(phaseTimingSchema),
    })
    .strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    // The run row first, then the lease: the same order as the heartbeat
    // (deploy.renew_run_lease), so the two cannot deadlock (review on #1251).
    await tx.execute(sql`SELECT 1 FROM deploy_runs WHERE id = ${input.runId}::uuid FOR UPDATE`);
    // Released before the run is recorded: this transaction keeps the lease
    // row locked until it commits, so nobody else releases in between.
    await releaseLiveRelease(tx, input.runId);
    await tx.execute(sql`
      UPDATE deploy_runs
         SET status = 'succeeded', finished_at = clock_timestamp(), error_message = NULL,
             page_count = ${input.pageCount}, file_count = ${input.fileCount},
             build_id = ${input.buildId},
             publish_summary = ${jsonbParam(input.publishSummary)},
             plugin_data = ${jsonbParam(input.pluginData)},
             phase_timings = ${jsonbParam(input.phaseTimings)},
             lease_expires_at = NULL
       WHERE id = ${input.runId}::uuid
    `);
    // #1157 — the release starts from the live build's files, which carry
    // the redirects of that build's time (self-hosted copies its archive
    // over `current/`); redirects saved since must stay live. Pushed after
    // this commit (deploy.build_plugin_data), never inside it.
    await markRedirectsBehind(tx, [input.targetId]);
    return ok({});
  },
});

export const finishPluginDataTickOp = defineOperation({
  name: "deploy.finish_plugin_data_tick",
  // Why system-only: the last step of deploy.build_plugin_data (system actor).
  actorScope: ["system"],
  database: "cms_admin",
  input: outcomeRecord.extend({
    /** Set when the targets now carry the data read at `bakedAt`. */
    baked: z
      .object({
        bakedAt: z.string(),
        plugins: z.array(z.object({ id: z.string(), pages: z.array(z.string()) })),
        /**
         * The run each target serves with this data: the plugin-data run
         * this tick published, or the live run its unchanged bake read.
         */
        targets: z.array(z.object({ targetId: z.string(), liveRunId: z.string() })),
      })
      .nullable(),
  }),
  output: z.object({ marksAdvanced: z.boolean() }),
  handler: async (ctx, input, tx) => {
    let marksAdvanced = false;
    if (input.baked && (await stillServed(tx, input.baked.targets))) {
      marksAdvanced = true;
      // Every target now carries the data read at `bakedAt` for the pages
      // of the plugins that rendered (or had nothing new). A mark that came
      // in after that instant stays pending.
      for (const plugin of input.baked.plugins) {
        await tx.execute(sql`
          UPDATE plugin_data_stale_pages
             SET baked_through = ${input.baked.bakedAt}::timestamptz,
                 last_run_id = ${input.runIds.at(-1) ?? null}
           WHERE plugin_id = ${plugin.id}::uuid
             AND page_id = ANY(${uuidList(plugin.pages)})
        `);
      }
    }
    await recordOutcome(tx, ctx, input);
    return ok({ marksAdvanced });
  },
});

/**
 * Whether every target still serves the run this tick left it with — read
 * under the live-release row lock, so no Publish live or rollback commits in
 * between. A release since then rewound or forgot the bakes (it serves
 * older data); advancing the marks over that would leave the data out of
 * the HTML until the next mark (review on #1251). Busy or moved: the marks
 * stay pending and the next tick bakes them again.
 */
async function stillServed(
  tx: TransactionRunner,
  targets: readonly { readonly targetId: string; readonly liveRunId: string }[],
): Promise<boolean> {
  if (!(await tryLockLiveRelease(tx, { skipLocked: false })).locked) return false;
  for (const t of targets) {
    if ((await liveRunOf(tx, t.targetId))?.id !== t.liveRunId) return false;
  }
  return true;
}

/** The body of deploy.build_plugin_data (see the module comment). */
async function runPluginDataBuild(
  ctx: ExecutionContext,
  input: z.infer<typeof buildInput>,
  steps: OperationSteps,
): Promise<Result<BuildOutput, QueryError>> {
  const { registry, adapter } = steps;
  const timer = new PhaseTimer();
  const started = await execute(registry, adapter, ctx, "deploy.start_plugin_data", {
    minIntervalSeconds: input.minIntervalSeconds,
    maxMarks: input.maxMarks,
  });
  if (!started.ok) return err(started.error);
  const plan = started.value as PluginDataPlan;
  if (plan.kind === "done") return ok(plan.result);
  timer.lap("prepare");

  const tally = { pendingPlugins: plan.pendingPlugins, marks: plan.marks };
  /** The run each target serves once this tick is done (see finish_plugin_data_tick). */
  const served = new Map(plan.targets.map((t) => [t.target.id, t.liveRunId]));
  const finishTick = async (
    outcome: "unchanged" | "built" | "blocked" | "failed",
    message: string | null,
    runIds: string[],
    baked: boolean,
  ): Promise<Result<BuildOutput, QueryError> | null> => {
    const r = await execute(registry, adapter, ctx, "deploy.finish_plugin_data_tick", {
      outcome,
      message,
      ...tally,
      runIds,
      baked: baked
        ? {
            bakedAt: plan.bakedAt,
            plugins: plan.plugins.map((p) => ({ id: p.id, pages: p.pages })),
            targets: [...served].map(([targetId, liveRunId]) => ({ targetId, liveRunId })),
          }
        : null,
    });
    return r.ok ? null : err(r.error);
  };
  const failed = async (
    message: string,
    runIds: string[],
  ): Promise<Result<BuildOutput, QueryError>> => {
    const recorded = await finishTick("failed", message, runIds, false);
    if (recorded && !recorded.ok) {
      console.error("[plugin-data] could not record the failed tick", recorded.error);
    }
    return err({ kind: "HandlerError", operation: "deploy.build_plugin_data", message });
  };

  const publisher = await loadStaticPublisher(process.env.CAELO_PROVIDER);
  const root = resolveOutputRoot(input.repoRoot);
  const renderable: RenderablePlugin[] = plan.plugins.map((p) => ({
    ...p,
    pages: new Set(p.pages),
  }));
  const sys = { actorId: SYSTEM_ACTOR_ID, actorKind: "system" as const, requestId: ctx.requestId };
  const runIds: string[] = [];
  let bakedPages = 0;
  let changedFiles = 0;
  const notes: string[] = [];
  for (const t of plan.targets) {
    const target: DeployTarget = t.target;
    const live: LiveBuildRef = {
      runId: t.liveRunId,
      buildId: t.liveBuildId,
      location: t.liveLocation,
      localBuildDir: resolve(root, t.target.outDir, "builds", t.liveBuildId),
    };
    // Reading the live files and rendering hold no lease: nothing here
    // writes, and the run's start below refuses when the live build moved.
    let bake: TargetBake;
    try {
      bake = await bakeTarget({
        publisher,
        target,
        live,
        plugins: renderable,
        bakedAt: plan.bakedAt,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof BlockedError) {
        const recorded = await finishTick("blocked", message, runIds, false);
        return recorded ?? ok(result("blocked", message, { runIds }));
      }
      return failed(`could not bake "${t.target.name}": ${message}`, runIds);
    }
    timer.lap(`bake:${t.target.name}`);
    if (bake.versionMismatch.length > 0) {
      notes.push(
        `On "${t.target.name}" ${bake.versionMismatch.join(", ")} rendered the live regions; the running version's markup goes live with the next Publish live.`,
      );
    }
    if (bake.files.size === 0) continue;

    const runId = randomUUID();
    const ttlMs = DEPLOY_RUN_LEASE_TTL_MS;
    const begun = await execute(registry, adapter, sys, "deploy.begin_plugin_data_run", {
      runId,
      targetId: t.target.id,
      liveRunId: t.liveRunId,
      caeloVersion: t.liveCaeloVersion,
      startedAt: plan.bakedAt,
      leaseTtlMs: ttlMs,
    });
    if (!begun.ok) {
      return failed(`could not start the plugin-data run: ${describeError(begun.error)}`, runIds);
    }
    const start = begun.value as
      | { started: true; pruneBuildIds: string[] }
      | { started: false; reason: string };
    if (!start.started) {
      // Another release owns the live site right now. Nothing is recorded:
      // the marks stay pending and the next tick bakes them.
      console.info(`[plugin-data] skipped: ${start.reason}`);
      return ok(result("busy", start.reason, { runIds }));
    }
    const heartbeat = new DeployRunHeartbeat(async (): Promise<DeployRunBeat> => {
      const r = await execute(registry, adapter, sys, "deploy.renew_run_lease", { runId, ttlMs });
      if (!r.ok) throw new Error(describeError(r.error));
      return r.value as DeployRunBeat;
    }, DEPLOY_RUN_HEARTBEAT_MS);
    heartbeat.expectLiveRelease(true);
    const summaryOfBake = {
      bakedPages: bake.bakedPages,
      notLive: bake.notLive,
      versionMismatch: bake.versionMismatch,
      plugins: renderable.map((p) => ({ slug: p.slug, version: p.version, pages: p.pages.size })),
      dataAsOf: plan.bakedAt,
    };
    const failRun = async (message: string): Promise<Result<BuildOutput, QueryError>> => {
      const r = await execute(registry, adapter, sys, "deploy.fail_run", {
        runId,
        message,
        phaseTimings: timer.phases(),
      });
      if (!r.ok)
        console.error("[plugin-data] could not record the failed run", { runId, error: r.error });
      return failed(message, [...runIds, runId]);
    };
    try {
      // Proof, right before the new version goes live (after any upload
      // that changes nothing served), that the run still holds the lease
      // (review on #1251).
      let lost: string | null = null;
      const beforeRelease = async (): Promise<void> => {
        const proof = await fenceRunLeases(steps, sys, {
          runId,
          ttlMs,
          need: { publication: false, liveRelease: true },
          lostMessage: (renewError) =>
            `the plugin-data build ${runId} lost its place in the live release order${renewError ? ` (${renewError})` : ""}; nothing was published, the marks stay pending.`,
        });
        if (!proof.ok) {
          lost = proof.message;
          throw new Error(proof.message);
        }
      };
      let summary: Awaited<ReturnType<StaticPublisher["publishPluginData"]>>;
      try {
        summary = await publisher.publishPluginData({
          target,
          live,
          runId,
          files: bake.files,
          pruneBuildIds: start.pruneBuildIds,
          beforeRelease,
        });
      } catch (e) {
        return await failRun(
          lost ?? `publishing plugin data failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      timer.lap(`publish:${t.target.name}`);
      const finished = await execute(registry, adapter, sys, "deploy.finish_plugin_data_run", {
        runId,
        targetId: t.target.id,
        pageCount: bake.bakedPages,
        fileCount: bake.files.size,
        buildId: summary.destinationBuildId,
        publishSummary: summary as unknown as Record<string, unknown>,
        pluginData: summaryOfBake,
        phaseTimings: timer.phases(),
      });
      if (!finished.ok) {
        return await failRun(
          `plugin data is live, but recording the run failed: ${describeError(finished.error)}`,
        );
      }
    } finally {
      await heartbeat.stop();
    }
    // The run is recorded; push the redirects onto the build the target now
    // serves (a failure is recorded and retried by the redirect-sync worker).
    const synced = await execute(registry, adapter, sys, "redirects.sync_provider", {
      trigger: "publish",
      targetIds: [t.target.id],
      ...(input.repoRoot ? { repoRoot: input.repoRoot } : {}),
    });
    if (!synced.ok) {
      console.error("[plugin-data] redirects not synced; retried automatically", {
        runId,
        error: describeError(synced.error),
      });
    }
    runIds.push(runId);
    served.set(t.target.id, runId);
    bakedPages += bake.bakedPages;
    changedFiles += bake.files.size;
  }

  const message = [plan.waitingNote, ...notes].filter((m): m is string => m !== null).join(" ");
  const outcome = runIds.length > 0 ? "built" : "unchanged";
  const recorded = await finishTick(outcome, message.length > 0 ? message : null, runIds, true);
  if (recorded) return recorded;
  console.info(
    `[plugin-data] ${outcome} in ${timer.totalMs()} ms`,
    JSON.stringify({ runIds, bakedPages, changedFiles, phases: timer.phases() }),
  );
  return ok(
    result(outcome, message.length > 0 ? message : null, { runIds, bakedPages, changedFiles }),
  );
}

export const buildPluginDataOp = defineStepwiseOperation({
  name: "deploy.build_plugin_data",
  // Why human-only: the plugin-data tick (plugin-data/worker.ts) runs it as
  // the system actor; it carries no decision — it republishes the build a
  // human published, with fresher data in plugin-owned regions only. No AI
  // tool: there is nothing for the AI to choose.
  actorScope: ["system"],
  database: "cms_admin",
  input: buildInput,
  output: buildOutput,
  stepwise: runPluginDataBuild,
});
