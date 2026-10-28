// SPDX-License-Identifier: MPL-2.0

/**
 * Bug intake core (epic #901, #903): one cluster per defect, one public
 * issue per cluster, whatever the number of installs reporting it.
 *
 * A report finds its cluster in three steps:
 *   1. the install's fingerprint, if a cluster of the report's kind already
 *      claimed it (an exact repeat: the same normalised error text for
 *      auto-captured reports, the same title for AI-filed ones);
 *   2. otherwise the semantic matcher over the candidate pool of the
 *      report's kind: the `MAX_CANDIDATES` newest clusters of that kind, of
 *      every tool and both sources (#1049). The AI writes the suspected tool freely ("stage_changes" vs
 *      "stage_changes (Firebase Hosting staging channel promotion)"), so the
 *      tool is a hint shown to the matcher, never a partition. AI and auto
 *      reports may join each other's clusters in both directions: an
 *      auto-captured error and the AI's report of the same failure are one
 *      defect, and their fingerprints can never be equal. Only a
 *      high-confidence answer naming an offered candidate links;
 *   3. otherwise a new cluster, which enters the pool at the front (a match
 *      moves the matched cluster to the front as well).
 * Steps 2 and 3 run one report at a time in this process, so a report sees
 * the cluster the report just before it created: two reports of one new
 * defect sent a second apart end in one cluster, not two. Exact repeats
 * (step 1) skip that queue.
 * Repeat reports only update the cluster's counters; the issue is created
 * once the cluster has `issueThresholdInstalls` distinct installs (1 = on
 * the first report), its body is refreshed when a new install or version
 * appears, and a comment is added at install milestones.
 *
 * Kinds (#1192): a report is a defect or a suggestion, and the two never
 * meet. Each kind has its own fingerprint index and candidate pool, so a
 * suggestion never joins a defect's cluster (or the other way round), and
 * its own daily slots and pending queue, so suggestions never take a
 * defect's issue slot. A maintainer's "close as duplicate" is the one way
 * a cluster can follow a cluster of the other kind: that is their decision.
 *
 * Public issues are bounded (#980), because registration is unauthenticated
 * and at threshold 1 anyone can file:
 *   - at most `maxNewIssuesPerDay` new defect issues and
 *     `maxNewSuggestionsPerDay` new suggestion issues per UTC calendar day
 *     (the windows reset at 00:00 UTC). A cluster due an issue over its
 *     kind's cap is stored as usual and queued; queued clusters are filed
 *     oldest first by later requests once the next day's slots exist. One
 *     kind's cap never holds back the other kind's queue. Updates to
 *     existing issues (body refresh, milestones, regression reopen) are not
 *     capped.
 *   - `issuesPaused` is the kill switch for both kinds: reports are still
 *     accepted, counted and queued, but GitHub is never written (no create,
 *     edit or comment). Skipped edits catch up on the next event that would
 *     make them.
 *
 * Issue state is read lazily (at most every few minutes per cluster) when a
 * report or status request touches the cluster, so the intake needs no
 * webhook: closed as completed → fixed (in the first release published after
 * the close, or the `fixed-in:<version>` label); a report from a version that
 * has the fix → reopened as a regression; closed as not planned → wontfix;
 * closed as duplicate → the cluster follows the original issue.
 *
 * Writes to one cluster, and matching + cluster creation as a whole, are
 * serialised in-process, and the service runs as a single instance (Cloud
 * Run max-instances=1); the store's version checks and first-writer-wins
 * links catch anything that still races.
 */

import {
  type BugIntakeClusterInfo,
  type BugIntakeReport,
  type BugReportKind,
  isNewerVersion,
  parseVersion,
  redactBugReportFields,
} from "@caelo-cms/shared";
import type { IssueState, ReleaseInfo } from "./github.js";
import { INSTALL_MILESTONES, issueBody, issueLabels, issueTitle } from "./issue-text.js";
import type { ClusterMatcher } from "./matcher.js";
import {
  type ClusterRecord,
  clusterSummary,
  type IntakeStore,
  REPORT_KINDS,
  type Versioned,
} from "./store.js";

/** The public tracker, bound to one repository. */
export interface IssueTracker {
  createIssue(issue: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<{ number: number; url: string }>;
  updateIssue(number: number, patch: { body?: string; state?: "open" | "closed" }): Promise<void>;
  getIssue(number: number): Promise<IssueState>;
  addComment(number: number, body: string): Promise<void>;
  recentCommentBodies(number: number): Promise<string[]>;
  releases(): Promise<ReleaseInfo[]>;
}

/** A request the intake refuses; `status` is the HTTP status to answer with. */
export class IntakeRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface IntakeServiceDeps {
  store: IntakeStore;
  tracker: IssueTracker;
  matcher: ClusterMatcher;
  issueThresholdInstalls: number;
  /** New public defect issues per UTC day; the rest wait in the defect queue. */
  maxNewIssuesPerDay: number;
  /**
   * New public suggestion issues per UTC day, a pool of its own (#1192); the
   * rest wait in the suggestion queue. 0 = suggestions are stored and queued
   * but never filed.
   */
  maxNewSuggestionsPerDay: number;
  /** Kill switch for both kinds: true = no GitHub write of any kind (reads still happen). */
  issuesPaused: boolean;
  now?: () => Date;
}

/** Issue state is re-read at most this often per cluster. */
const ISSUE_SYNC_INTERVAL_MS = 5 * 60_000;
/** Cap on stored install hashes per cluster; beyond it the count shows as "N+". */
const MAX_INSTALL_HASHES = 10_000;
/**
 * Queued issues filed per request at most: after the daily reset the backlog
 * drains over the first few requests instead of stalling one of them.
 */
const PENDING_ISSUES_PER_REQUEST = 3;

/** The daily issue window: the UTC calendar day of `d`, `YYYY-MM-DD`. */
function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(d).toString("hex");
}

const SEVERITY_RANK = { cosmetic: 0, degraded: 1, blocking: 2 } as const;

/**
 * Lock key that serialises matching and cluster creation. Cluster ids start
 * with `c_`, so it never shares a queue with a cluster's writes.
 */
const FIND_OR_CREATE_LOCK = "find-or-create";

/**
 * Id of a new cluster. Derived from the fingerprint so a second intake
 * process creating the same cluster collides on it; suggestions get their
 * own prefix because the two kinds' fingerprint indexes are separate and the
 * same fingerprint may open one cluster of each.
 */
function newClusterId(kind: BugReportKind, fingerprint: string): string {
  return `${kind === "suggestion" ? "c_s" : "c_"}${fingerprint.slice(0, 20)}`;
}

export class IntakeService {
  readonly #d: Required<IntakeServiceDeps>;
  readonly #locks = new Map<string, Promise<unknown>>();
  /**
   * Per kind, the UTC day whose issue slots are known to be used up; saves a
   * store round-trip per request.
   */
  readonly #capReachedDay: Record<BugReportKind, string | null> = {
    defect: null,
    suggestion: null,
  };
  #draining = false;

  constructor(deps: IntakeServiceDeps) {
    this.#d = { now: () => new Date(), ...deps };
  }

  /** Pin an install's public key (trust on first use). */
  async register(installId: string, publicKey: string): Promise<void> {
    const r = await this.#d.store.pinInstallKey(installId, publicKey);
    if (r === "conflict") {
      throw new IntakeRefusal(
        409,
        "This install id is already registered with a different key. Reset the bug-forwarding identity on the install.",
      );
    }
  }

  /** Accept one report from a verified install; answers with its cluster's state. */
  async ingest(installId: string, sent: BugIntakeReport): Promise<BugIntakeClusterInfo> {
    const installHash = await sha256Hex(installId);
    const prior = await this.#d.store.getReport(sent.reportId);
    if (prior) {
      if (prior.installHash !== installHash) {
        throw new IntakeRefusal(409, "This report id was already sent by another install.");
      }
      // A retry of a report already counted (the answer got lost on the way back).
      const info = this.#info(await this.#resolve(prior.clusterId));
      await this.#fileQueuedIssues();
      return info;
    }
    const report = { ...sent, ...redactBugReportFields(sent) };
    const clusterId = await this.#findOrCreateCluster(report);
    const info = await this.#withLock(clusterId, () =>
      this.#record(clusterId, installHash, report),
    );
    await this.#d.store.putReport({
      reportId: report.reportId,
      installHash,
      receivedAt: this.#d.now().toISOString(),
      clusterId: info.clusterId,
      report,
    });
    await this.#fileQueuedIssues();
    return info;
  }

  /** Current state of clusters an install reported into; unknown ids are left out. */
  async status(clusterIds: string[]): Promise<BugIntakeClusterInfo[]> {
    const out: BugIntakeClusterInfo[] = [];
    for (const id of new Set(clusterIds)) {
      const resolved = await this.#resolve(id).catch(() => null);
      if (!resolved) continue;
      const synced = await this.#withLock(resolved.value.id, () =>
        this.#syncIssue(resolved.value.id),
      );
      out.push({ ...this.#info(synced), clusterId: id });
    }
    await this.#fileQueuedIssues();
    return out;
  }

  async #findOrCreateCluster(report: BugIntakeReport): Promise<string> {
    const known = await this.#d.store.clusterIdForFingerprint(report.kind, report.fingerprint);
    if (known) return (await this.#resolve(known)).value.id;
    return this.#withLock(FIND_OR_CREATE_LOCK, () => this.#matchOrCreate(report));
  }

  /** Steps 2 and 3 of the file header; runs under `FIND_OR_CREATE_LOCK`. */
  async #matchOrCreate(report: BugIntakeReport): Promise<string> {
    const { store, matcher } = this.#d;
    const { kind, fingerprint } = report;
    // The report queued behind may have carried this very fingerprint.
    const known = await store.clusterIdForFingerprint(kind, fingerprint);
    if (known) return (await this.#resolve(known)).value.id;

    // Only clusters of the report's kind are offered, so the matcher cannot
    // put a suggestion into a defect's cluster or the other way round.
    const matched = await matcher.match(report, await store.candidates(kind));
    if (matched) {
      const link = await store.linkFingerprint(kind, fingerprint, matched);
      const id =
        link === "linked" ? matched : await store.clusterIdForFingerprint(kind, fingerprint);
      if (id) {
        const owner = await this.#resolve(id);
        await store.addCandidate(clusterSummary(owner.value));
        return owner.value.id;
      }
    }

    const now = this.#d.now().toISOString();
    const cluster: ClusterRecord = {
      id: newClusterId(kind, fingerprint),
      createdAt: now,
      kind,
      source: report.source,
      suspectedTool: report.suspectedTool,
      title: report.title,
      whatHappened: report.whatHappened,
      expected: report.expected,
      severity: report.severity,
      blockedTask: report.blockedTask,
      fingerprints: [report.fingerprint],
      installHashes: [],
      occurrences: 0,
      versions: [],
      firstSeen: now,
      lastSeen: now,
      issueNumber: null,
      issueUrl: null,
      status: "open",
      fixedInVersion: null,
      mergedInto: null,
      lastIssueSyncAt: null,
      milestonesCommented: [],
    };
    // Another intake instance (the store's backstop) may have created it already.
    await store.putCluster(cluster, null);
    const link = await store.linkFingerprint(kind, fingerprint, cluster.id);
    if (link === "taken") {
      const id = await store.clusterIdForFingerprint(kind, fingerprint);
      if (id) return (await this.#resolve(id)).value.id;
    }
    await store.addCandidate(clusterSummary(cluster));
    return cluster.id;
  }

  /** Follow duplicate merges to the cluster that now owns the defect. */
  async #resolve(id: string): Promise<Versioned<ClusterRecord>> {
    let cur = await this.#d.store.getCluster(id);
    for (let hops = 0; cur?.value.mergedInto && hops < 10; hops++) {
      cur = await this.#d.store.getCluster(cur.value.mergedInto);
    }
    if (!cur) throw new Error(`cluster ${id} is referenced but missing from the store`);
    return cur;
  }

  async #record(
    clusterId: string,
    installHash: string,
    report: BugIntakeReport,
  ): Promise<BugIntakeClusterInfo> {
    await this.#syncIssue(clusterId);
    const { cluster, isNewInstall, isNewVersion } = await this.#update(clusterId, (c) => {
      const isNewInstall =
        !c.installHashes.includes(installHash) && c.installHashes.length < MAX_INSTALL_HASHES;
      const isNewVersion = !c.versions.includes(report.caeloVersion);
      if (isNewInstall) c.installHashes.push(installHash);
      if (isNewVersion) c.versions.push(report.caeloVersion);
      if (!c.fingerprints.includes(report.fingerprint)) c.fingerprints.push(report.fingerprint);
      // Severity grades defects only; a suggestion cluster (and a suggestion
      // report) has none.
      if (
        c.severity !== null &&
        report.severity !== null &&
        SEVERITY_RANK[report.severity] > SEVERITY_RANK[c.severity]
      ) {
        c.severity = report.severity;
      }
      c.blockedTask ||= report.blockedTask;
      c.occurrences += 1;
      c.lastSeen = this.#d.now().toISOString();
      return { isNewInstall, isNewVersion };
    });

    let current = cluster;
    const writable = !this.#d.issuesPaused;
    if (
      writable &&
      current.status === "fixed" &&
      current.fixedInVersion !== null &&
      current.issueNumber !== null
    ) {
      // Reported from a release that contains the fix: it came back. A
      // report whose filing version is unknown (filed before the install
      // recorded it, #1072) proves nothing about the fix, so it never
      // reopens the issue.
      if (
        isKnownVersion(report.caeloVersion) &&
        !isNewerVersion(current.fixedInVersion, report.caeloVersion)
      ) {
        const fixedIn = current.fixedInVersion;
        await this.#d.tracker.updateIssue(current.issueNumber, { state: "open" });
        await this.#d.tracker.addComment(
          current.issueNumber,
          `Reported again from Caelo ${report.caeloVersion}, which contains the fix from ${fixedIn}. Reopened as a regression.`,
        );
        current = (
          await this.#update(clusterId, (c) => {
            c.status = "regression";
            c.fixedInVersion = null;
          })
        ).cluster;
      }
    }

    if (current.issueNumber === null) {
      if (current.installHashes.length >= this.#d.issueThresholdInstalls) {
        current = await this.#fileIssue(current);
      }
    } else if (writable && (isNewInstall || isNewVersion)) {
      await this.#d.tracker.updateIssue(current.issueNumber, { body: issueBody(current) });
      const due = INSTALL_MILESTONES.filter(
        (m) => current.installHashes.length >= m && !current.milestonesCommented.includes(m),
      );
      const top = due.at(-1);
      if (top !== undefined) {
        await this.#d.tracker.addComment(
          current.issueNumber,
          `Now reported from ${top}+ installs.`,
        );
        current = (
          await this.#update(clusterId, (c) => {
            c.milestonesCommented.push(...due);
          })
        ).cluster;
      }
    }
    return this.#info(current);
  }

  /** Today's new-issue limit of a kind. */
  #dailyCap(kind: BugReportKind): number {
    return kind === "suggestion" ? this.#d.maxNewSuggestionsPerDay : this.#d.maxNewIssuesPerDay;
  }

  /**
   * Give a cluster that is due one its public issue, if the kill switch and
   * today's cap of its kind allow; otherwise leave it queued. Call under the
   * cluster's lock. The cluster is queued before GitHub is called, so a
   * failed create is retried by a later request rather than lost.
   */
  async #fileIssue(cluster: ClusterRecord): Promise<ClusterRecord> {
    const { store, tracker } = this.#d;
    const { kind } = cluster;
    await store.markIssuePending(kind, cluster.id, this.#d.now().toISOString());
    if (this.#d.issuesPaused) return cluster;
    const day = utcDay(this.#d.now());
    if (this.#capReachedDay[kind] === day) return cluster;
    if (!(await store.takeIssueSlot(kind, day, this.#dailyCap(kind)))) {
      this.#capReachedDay[kind] = day;
      return cluster;
    }
    let issue: { number: number; url: string };
    try {
      issue = await tracker.createIssue({
        title: issueTitle(cluster),
        body: issueBody(cluster),
        labels: issueLabels(cluster),
      });
    } catch (e) {
      await store.returnIssueSlot(kind, day);
      this.#capReachedDay[kind] = null;
      throw e;
    }
    await store.linkIssue(issue.number, cluster.id);
    const { cluster: filed } = await this.#update(cluster.id, (c) => {
      c.issueNumber = issue.number;
      c.issueUrl = issue.url;
      c.lastIssueSyncAt = this.#d.now().toISOString();
    });
    await store.clearIssuePending(kind, cluster.id);
    return filed;
  }

  /**
   * File queued issues of each kind, oldest first, while the kill switch and
   * that kind's cap for today allow. Piggybacks on install requests because
   * the service scales to zero and has no scheduler; at least one install
   * refreshes status every six hours, so a queued cluster waits at most that
   * long past the daily reset. A failure here is logged, not thrown: it is
   * the intake's own backlog and must not fail an unrelated install's
   * request. Each kind drains on its own, so one kind's full cap or failure
   * never holds back the other's queue.
   */
  async #fileQueuedIssues(): Promise<void> {
    if (this.#d.issuesPaused || this.#draining) return;
    this.#draining = true;
    try {
      for (const kind of REPORT_KINDS) await this.#fileQueuedIssuesOf(kind);
    } finally {
      this.#draining = false;
    }
  }

  async #fileQueuedIssuesOf(kind: BugReportKind): Promise<void> {
    if (this.#capReachedDay[kind] === utcDay(this.#d.now())) return;
    const { store } = this.#d;
    try {
      for (const id of await store.pendingIssueClusters(kind, PENDING_ISSUES_PER_REQUEST)) {
        await this.#withLock(id, async () => {
          const cur = await store.getCluster(id);
          if (!cur || cur.value.issueNumber !== null) {
            await store.clearIssuePending(kind, id);
            return;
          }
          await this.#fileIssue(cur.value);
        });
        if (this.#capReachedDay[kind] === utcDay(this.#d.now())) break;
      }
    } catch (e) {
      console.error(
        `[bug-intake] filing queued ${kind} issues failed; retried on a later request:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  /** Read-modify-write one cluster with the store's version check. */
  async #update<T>(
    clusterId: string,
    mutate: (c: ClusterRecord) => T,
  ): Promise<{ cluster: ClusterRecord } & (T extends object ? T : object)> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const cur = await this.#d.store.getCluster(clusterId);
      if (!cur) throw new Error(`cluster ${clusterId} vanished from the store`);
      const extra = mutate(cur.value);
      if ((await this.#d.store.putCluster(cur.value, cur.version)) === "ok") {
        return { cluster: cur.value, ...(extra as object) } as {
          cluster: ClusterRecord;
        } & (T extends object ? T : object);
      }
    }
    throw new Error(`cluster ${clusterId}: five write conflicts in a row`);
  }

  /** Bring the cluster's status in line with its issue (lazy, rate-limited). */
  async #syncIssue(clusterId: string): Promise<ClusterRecord> {
    const cur = await this.#resolve(clusterId);
    const c = cur.value;
    const fresh =
      c.lastIssueSyncAt !== null &&
      this.#d.now().getTime() - Date.parse(c.lastIssueSyncAt) < ISSUE_SYNC_INTERVAL_MS;
    if (c.issueNumber === null || fresh) return c;

    const issue = await this.#d.tracker.getIssue(c.issueNumber);
    let next: Pick<
      ClusterRecord,
      "status" | "fixedInVersion" | "issueNumber" | "issueUrl" | "mergedInto"
    > = {
      status: c.status,
      fixedInVersion: c.fixedInVersion,
      issueNumber: c.issueNumber,
      issueUrl: issue.url,
      mergedInto: c.mergedInto,
    };
    if (issue.state === "open") {
      next.status = c.status === "regression" ? "regression" : "open";
      next.fixedInVersion = null;
    } else if (issue.stateReason === "not_planned") {
      next.status = "wontfix";
    } else if (issue.stateReason === "duplicate") {
      next = await this.#followDuplicate(c, next);
    } else {
      next.status = "fixed";
      next.fixedInVersion = await this.#fixedIn(issue);
    }
    const { cluster } = await this.#update(c.id, (x) => {
      Object.assign(x, next);
      x.lastIssueSyncAt = this.#d.now().toISOString();
    });
    if (cluster.mergedInto) return (await this.#resolve(cluster.id)).value;
    return cluster;
  }

  async #followDuplicate(
    c: ClusterRecord,
    next: Pick<
      ClusterRecord,
      "status" | "fixedInVersion" | "issueNumber" | "issueUrl" | "mergedInto"
    >,
  ) {
    if (c.issueNumber === null) return next;
    const original = (await this.#d.tracker.recentCommentBodies(c.issueNumber))
      .map((b) => /Duplicate of #(\d+)/i.exec(b)?.[1])
      .find((n) => n !== undefined);
    if (!original) return { ...next, status: "fixed" as const, fixedInVersion: null };
    const number = Number(original);
    const other = await this.#d.store.clusterIdForIssue(number);
    if (other && other !== c.id) return { ...next, mergedInto: other };
    // The original is a human-filed issue: this cluster follows it from now on.
    const target = await this.#d.tracker.getIssue(number);
    await this.#d.store.linkIssue(number, c.id);
    return {
      ...next,
      issueNumber: number,
      issueUrl: target.url,
      status: target.state === "open" ? ("open" as const) : ("fixed" as const),
      fixedInVersion: target.state === "open" ? null : await this.#fixedIn(target),
    };
  }

  /** The first release carrying a closed issue's fix, if one has shipped. */
  async #fixedIn(issue: IssueState): Promise<string | null> {
    const label = issue.labels.find((l) => l.startsWith("fixed-in:"));
    if (label) return label.slice("fixed-in:".length).replace(/^v/, "");
    if (!issue.closedAt) return null;
    const after = (await this.#d.tracker.releases())
      .filter((r) => r.publishedAt > (issue.closedAt as string))
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
    return after[0]?.version ?? null;
  }

  #info(c: ClusterRecord | Versioned<ClusterRecord>): BugIntakeClusterInfo {
    const v = "value" in c ? c.value : c;
    return {
      clusterId: v.id,
      status: v.status,
      issueUrl: v.issueUrl,
      fixedInVersion: v.fixedInVersion,
    };
  }

  /** Serialise work on one cluster within this process. */
  async #withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    this.#locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.#locks.get(key) === run) this.#locks.delete(key);
    }
  }
}

/** True when `raw` is a release version the regression check can compare. */
function isKnownVersion(raw: string): boolean {
  try {
    parseVersion(raw.replace(/^v/, ""));
    return true;
  } catch {
    return false;
  }
}
