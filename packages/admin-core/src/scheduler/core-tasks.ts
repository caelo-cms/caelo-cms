// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1140 category B — the core maintenance tasks of the scheduler
 * tick, with their cadences (the maintainer's due-table defaults of
 * 2026-10-26, kept as they were on the in-process timers):
 *
 * | Task                         | Cadence     |
 * |------------------------------|-------------|
 * | projection outbox backstop   | every tick  |
 * | redirect sync retry          | every tick  |
 * | bug forwarding (send)        | every tick  |
 * | public mail outboxes (#1337) | every tick  |
 * | reporting jobs (#1359)       | every tick  |
 * | plugin-data build (#1155)    | 5 minutes   |
 * | update scheduler             | 15 minutes  |
 * | release check                | hourly      |
 * | login rate-limit GC          | hourly      |
 * | change journal GC            | hourly      |
 * | bug forwarding (status)      | 6 hours     |
 * | proposal + staging-bucket GC | daily       |
 * | chat-image GC                | daily       |
 * | reporting-job rows GC        | daily       |
 *
 * Every-tick tasks come first: they are cheap, and the order decides which
 * tasks wait when a tick's budget runs out.
 *
 * None of these builds or publishes production (CLAUDE.md §2, one path to
 * live; scripts/no-automatic-production-deploy.test.ts pins it). The
 * plugin-data build republishes the live build with fresher plugin-owned
 * regions only (#1155).
 */

import { pluginHostBootstrapped } from "@caelo-cms/plugin-host";
import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import type { BugIntakeClient } from "../bug-forwarding/client.js";
import {
  BUG_STATUS_REFRESH_SECONDS,
  forwardDueReports,
  refreshClusterStatus,
} from "../bug-forwarding/worker.js";
import { sweepChangeJournal } from "../change-journal-gc-worker.js";
import { sweepChatImagesOnce } from "../chat-image-gc-worker.js";
import { describeDrain, drainPublicOutboxes } from "../email/outbox.js";
import { type AutoUpdateSchedulerOpts, runAutoUpdateTick } from "../platform-updates/scheduler.js";
import { runPluginDataBuildIfDue } from "../plugin-data/worker.js";
import { sweepStaleProposals } from "../proposal-gc-worker.js";
import type { PublicProjectionPublisher } from "../public-projection.js";
import { sweepExpiredRateLimitBuckets } from "../rate-limit-gc-worker.js";
import { retryRedirectSync } from "../redirect-sync-worker.js";
import { type ReleaseCheckOpts, runReleaseCheck } from "../release-check-worker.js";
import { runReportingJobBackstop, sweepFinishedReportingJobs } from "../reporting-jobs/backstop.js";
import { DEFAULT_TASK_LEASE_SECONDS, type ScheduledTask } from "./task.js";

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/** What the core tasks need from the admin process. */
export interface CoreTaskDeps {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  /** The process's projection publisher; null until the plugin host booted it. */
  readonly projectionPublisher: () => PublicProjectionPublisher | null;
  readonly bugIntake: BugIntakeClient;
  /**
   * The release check's manifest reader and provider; null leaves the task
   * out (`CAELO_RELEASE_CHECK=off`: test runs seed the cache themselves).
   */
  readonly releaseCheck: Omit<ReleaseCheckOpts, "adapter"> | null;
  /**
   * The update scheduler's upgrader, converge job and manifest reader; null
   * leaves the task out (`CAELO_UPDATE_SCHEDULER=off` for test runs).
   */
  readonly autoUpdate: Omit<AutoUpdateSchedulerOpts, "adapter" | "registry"> | null;
  /**
   * #1337 — the admin's adapter on cms_public_staging, for the staging
   * mail outbox. Defaults to the plugin host's (the admin process always
   * has one); a test passes its own.
   */
  readonly stagingAdapter?: () => DatabaseAdapter | null;
}

/** Build a task, defaulting its lease. */
function task(
  name: string,
  everySeconds: number,
  run: () => Promise<string | undefined>,
  leaseSeconds = DEFAULT_TASK_LEASE_SECONDS,
): ScheduledTask {
  return { key: `core:${name}`, cadence: { everySeconds }, leaseSeconds, run };
}

/** The core maintenance tasks, in tick order. */
export function coreScheduledTasks(deps: CoreTaskDeps): ScheduledTask[] {
  const { adapter, registry } = deps;
  const bug = { adapter, registry, client: deps.bugIntake };
  const tasks: ScheduledTask[] = [
    task("projection-backstop", 0, async () => {
      const publisher = deps.projectionPublisher();
      // The plugin host boots the publisher before any request runs (the
      // tick's request waits for it); none means that boot failed, which
      // the boot logged. Reported here too so the task row says so.
      if (!publisher)
        throw new Error(
          "the projection publisher did not start (see [hooks] plugin host boot errors)",
        );
      const report = await publisher.backstop();
      if (report.drained === 0) return undefined;
      // #1329 — per public database. The backstop republishes what the
      // outbox marks; it never freezes or points a release (only a Stage or
      // Publish live does, scripts/no-automatic-production-deploy.test.ts).
      const parts = Object.entries(report.sections)
        .filter(([, sections]) => sections.length > 0)
        .map(([target, sections]) => `${target}: ${sections.join(", ")}`);
      return `published ${parts.length > 0 ? parts.join("; ") : "nothing"}`;
    }),
    task("redirect-sync-retry", 0, async () => {
      const behind = await retryRedirectSync({ adapter, registry });
      if (behind > 0)
        throw new Error(`${behind} target(s) still not live (Settings → Redirects shows why)`);
      return undefined;
    }),
    task("bug-forwarding-send", 0, async () => {
      const sent = await forwardDueReports(bug);
      return sent > 0 ? `${sent} report(s) handled` : undefined;
    }),
    // #1337 — the mail the public gateways queued (double opt-in, password
    // reset), live then staging. Every tick: a confirmation link is waited for.
    task("mail-outbox", 0, async () => {
      const reports = await drainPublicOutboxes({
        registry,
        adapter,
        targets: {
          live: adapter,
          staging: deps.stagingAdapter
            ? deps.stagingAdapter()
            : (pluginHostBootstrapped()?.infra.stagingAdapter ?? null),
        },
      });
      return describeDrain(reports);
    }),
    // #1359 — restart a reporting job (the quality audit's) whose lease ran
    // out, start one for work that has none. Every tick: an audit waits.
    task("reporting-jobs", 0, () => runReportingJobBackstop({ adapter, registry })),
    task("plugin-data-build", 5 * MINUTE, async () => {
      // The due-table spaces the runs; the op's own spacing would only
      // skip a run the tick already decided is due.
      const r = await runPluginDataBuildIfDue({ adapter, registry, minIntervalSeconds: 0 });
      if (r.outcome === "blocked") throw new Error(`not built: ${r.message ?? "blocked"}`);
      return `${r.outcome}${r.hintedPages > 0 ? `, ${r.hintedPages} page(s) hinted` : ""}`;
    }),
  ];
  if (deps.autoUpdate) {
    const autoUpdate = deps.autoUpdate;
    tasks.push(
      task("update-scheduler", 15 * MINUTE, async () => {
        const r = await runAutoUpdateTick({ ...autoUpdate, adapter, registry });
        return r.ran ? `decided: ${r.action ?? "none"}` : undefined;
      }),
    );
  }
  if (deps.releaseCheck) {
    const releaseCheck = deps.releaseCheck;
    tasks.push(
      task("release-check", HOUR, async () => {
        await runReleaseCheck({ ...releaseCheck, adapter });
        return undefined;
      }),
    );
  }
  tasks.push(
    task("rate-limit-gc", HOUR, async () => {
      await sweepExpiredRateLimitBuckets(adapter);
      return undefined;
    }),
    task("change-journal-gc", HOUR, async () => {
      await sweepChangeJournal({ adapter, registry });
      return undefined;
    }),
    task("bug-forwarding-status", BUG_STATUS_REFRESH_SECONDS, async () => {
      const refreshed = await refreshClusterStatus(bug);
      return refreshed > 0 ? `${refreshed} cluster(s) refreshed` : undefined;
    }),
    task("proposal-gc", 24 * HOUR, async () => {
      const r = await sweepStaleProposals({ adapter });
      return r.totalMarked + r.deletedObjects > 0
        ? `${r.totalMarked} proposal(s) superseded, ${r.deletedObjects} staging object(s) deleted`
        : undefined;
    }),
    task("chat-image-gc", 24 * HOUR, async () => {
      const r = await sweepChatImagesOnce({ adapter });
      return r.deletedObjects + r.clearedRows > 0
        ? `${r.deletedObjects} image(s) deleted, ${r.clearedRows} message(s) cleared`
        : undefined;
    }),
    task("reporting-jobs-gc", 24 * HOUR, async () => {
      const deleted = await sweepFinishedReportingJobs({ adapter, registry });
      return deleted > 0 ? `${deleted} finished job row(s) and build order(s) deleted` : undefined;
    }),
  );
  return tasks;
}
