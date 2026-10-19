// SPDX-License-Identifier: MPL-2.0

/**
 * Settings → Updates in plain language (#696, #861): the page's one state
 * (`updatePageState`) with its sentence and single primary action, what
 * each phase of an upgrader run and each end state means, and the one-line
 * summaries of the collapsed sections — for an Owner who has never heard of
 * a migration, a revision or install.json.
 */

import type {
  PlatformUpdatePhase,
  PlatformUpdateStatusValue,
  UpdatePolicyMode,
} from "@caelo-cms/shared";

/**
 * The timeline's steps, in order (rollback only shows when it happened).
 * The last one, `finish`, is named by its outcome: {@link phaseLabel}.
 */
export const PHASE_LABELS: Readonly<Record<Exclude<PlatformUpdatePhase, "finish">, string>> = {
  queued: "Requested",
  start: "Upgrader started",
  verify: "Checking the release is genuine",
  assess: "Checking it fits this site",
  backup: "Backing up your database",
  "health-baseline": "Making sure the site can be tested",
  migrations: "Updating the database",
  roll: "Switching to the new version",
  health: "Testing the new version",
  rollback: "Going back to the previous version",
  record: "Recording the new version",
  "self-update": "Updating the updater",
};

/** Status badge text + tone. */
export const STATUS_DISPLAY: Readonly<
  Record<
    PlatformUpdateStatusValue,
    { readonly label: string; readonly tone: "secondary" | "success" | "warning" | "destructive" }
  >
> = {
  pending: { label: "Waiting to start", tone: "secondary" },
  running: { label: "Installing", tone: "secondary" },
  succeeded: { label: "Installed", tone: "success" },
  rolled_back: { label: "Rolled back", tone: "warning" },
  failed: { label: "Failed", tone: "destructive" },
  refused: { label: "Not installed", tone: "destructive" },
  needs_cloud_shell: { label: "Needs Cloud Shell", tone: "warning" },
  cancelled: { label: "Cancelled", tone: "secondary" },
  superseded: { label: "No longer needed", tone: "secondary" },
};

/**
 * The badge for `status` on this kind of install: a self-hosted install's
 * hand-run upgrade happens on its server, not in Cloud Shell (#696 Phase 4c).
 */
export function statusDisplay(
  status: PlatformUpdateStatusValue,
  selfHosted: boolean,
): (typeof STATUS_DISPLAY)[PlatformUpdateStatusValue] {
  if (status === "needs_cloud_shell" && selfHosted) {
    return { label: "Needs a manual upgrade", tone: "warning" };
  }
  return STATUS_DISPLAY[status];
}

/** Whether a request is still in flight (the page keeps polling). */
export function isActive(status: PlatformUpdateStatusValue): boolean {
  return status === "pending" || status === "running";
}

/**
 * How long ago the release check ran, in words: "just now", "40 min ago",
 * "3 h ago", "2 days ago". A time in the future (clock skew between the
 * database and this server) reads as "just now".
 */
export function checkedAgo(checkedAt: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - new Date(checkedAt).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * What the "Your version" card says about the release check. `up_to_date`
 * only when the last check actually reached GitHub — a check that never ran
 * or failed must not read as "Up to date".
 */
export type ReleaseCheckState =
  | { readonly kind: "never" }
  | { readonly kind: "failed"; readonly ago: string }
  | { readonly kind: "up_to_date" | "update_available"; readonly ago: string };

/** The release-check state for `platform_updates.status`'s fields at `now`. */
export function releaseCheckState(
  status: {
    readonly latestVersion: string | null;
    readonly upgradeAvailable: boolean;
    readonly checkedAt: string | null;
  },
  now: Date,
): ReleaseCheckState {
  if (status.checkedAt === null) return { kind: "never" };
  const ago = checkedAgo(status.checkedAt, now);
  if (status.latestVersion === null) return { kind: "failed", ago };
  return { kind: status.upgradeAvailable ? "update_available" : "up_to_date", ago };
}

/* ------------------------------------------------------------------------ */
/* How a run ended (#861): outcomes, not phases.                            */
/* ------------------------------------------------------------------------ */

/**
 * Phases in which the upgrader changes the install: from the database
 * migrations on. Everything before (signature, fit check, backup, the
 * health baseline) leaves the site as it was.
 */
const CHANGING_PHASES: ReadonlySet<PlatformUpdatePhase> = new Set([
  "migrations",
  "roll",
  "health",
  "rollback",
  "record",
  "self-update",
]);

/** Whether a run's timeline shows it never reached a step that changes the install. */
export function stoppedBeforeChange(
  events: readonly { readonly phase: PlatformUpdatePhase }[],
): boolean {
  return !events.some((e) => CHANGING_PHASES.has(e.phase));
}

/**
 * The label of a finished run's last timeline step: what came out of it.
 * A run refused before it changed anything never reads "Finished" (#861).
 */
export function finishLabel(
  status: PlatformUpdateStatusValue,
  events: readonly { readonly phase: PlatformUpdatePhase }[],
): string {
  switch (status) {
    case "succeeded":
      return "Installed";
    case "rolled_back":
      return "Went back to the previous version";
    case "cancelled":
      return "Cancelled before it started";
    case "superseded":
      return "No longer needed";
    case "pending":
    case "running":
      return "Finishing";
    default:
      return stoppedBeforeChange(events)
        ? "Stopped before changing anything"
        : "Stopped before it finished";
  }
}

/** The label of one timeline step; the last one says how the run ended. */
export function phaseLabel(
  phase: PlatformUpdatePhase,
  status: PlatformUpdateStatusValue,
  events: readonly { readonly phase: PlatformUpdatePhase }[],
): string {
  return phase === "finish" ? finishLabel(status, events) : PHASE_LABELS[phase];
}

/** The steps an Owner sees while an update runs, in order. */
const PROGRESS_STEPS: readonly {
  readonly label: string;
  readonly phases: readonly PlatformUpdatePhase[];
}[] = [
  { label: "checking the release", phases: ["verify", "assess"] },
  { label: "backing up your database", phases: ["backup", "health-baseline"] },
  { label: "updating the database", phases: ["migrations"] },
  { label: "switching to the new version", phases: ["roll"] },
  { label: "testing the new version", phases: ["health", "rollback", "record", "self-update"] },
];

/**
 * The one sentence for an update in flight: which step of how many, in
 * words. Recomputed from the live timeline while the page polls.
 */
export function progressSentence(
  request: { readonly status: PlatformUpdateStatusValue; readonly targetVersion: string },
  events: readonly { readonly phase: PlatformUpdatePhase }[],
): string {
  const leave = "You can leave this page.";
  let step = 0;
  for (const e of events) {
    const i = PROGRESS_STEPS.findIndex((s) => s.phases.includes(e.phase));
    if (i + 1 > step) step = i + 1;
  }
  if (request.status === "pending" || step === 0) {
    return `Caelo installs v${request.targetVersion} as soon as the upgrader starts. ${leave}`;
  }
  const current = PROGRESS_STEPS[step - 1] as (typeof PROGRESS_STEPS)[number];
  return `Caelo is installing v${request.targetVersion}. Step ${step} of ${PROGRESS_STEPS.length}: ${current.label}. ${leave}`;
}

/* ------------------------------------------------------------------------ */
/* The page's one state (#861).                                             */
/* ------------------------------------------------------------------------ */

/** The nine states of Settings → Updates, in priority order (first match wins). */
export const UPDATE_PAGE_STATES = [
  "no_permission",
  "in_progress",
  "interrupted",
  "rolled_back",
  "break_glass",
  "update_available",
  "scheduled",
  "up_to_date",
  "unknown",
] as const;
export type UpdatePageStateKind = (typeof UPDATE_PAGE_STATES)[number];

/**
 * How the viewer can install a release from this page right now:
 * `in_product` = the Install button (platform.update + an upgrader on this
 * install); `terminal` = the pinned upgrade command (settings.write);
 * `none` = neither (no permission, or no upgrade path for this provider).
 */
export type InstallRoute = "in_product" | "terminal" | "none";

/** The one primary action of the page. */
export type PrimaryAction =
  | { readonly kind: "none" }
  /** The password-confirmed Install dialog for `version`. */
  | { readonly kind: "install"; readonly version: string; readonly label: string }
  /** The pinned upgrade command for `version`. */
  | { readonly kind: "terminal"; readonly version: string }
  /** Google Cloud Shell with the upgrade walkthrough for `version` (break-glass). */
  | { readonly kind: "cloud_shell"; readonly version: string }
  /** Self-hosted break-glass: the upgrade command on the server. */
  | { readonly kind: "server_command"; readonly version: string }
  /** The live timeline replaces the card body; cancel only while it waits. */
  | { readonly kind: "timeline"; readonly cancellable: boolean }
  /** The log of an upgrader run that died without reporting back. */
  | { readonly kind: "logs"; readonly url: string }
  /** Ask GitHub for the newest release now. */
  | { readonly kind: "check_now" };

/** What the status card shows. */
export interface UpdatePageState {
  readonly kind: UpdatePageStateKind;
  readonly badge: {
    readonly label: string;
    readonly tone: "secondary" | "success" | "warning" | "destructive";
  };
  /** The one sentence. */
  readonly sentence: string;
  /** An optional second line (why, or what else to expect); null when there is none. */
  readonly detail: string | null;
  readonly action: PrimaryAction;
}

/** Everything {@link updatePageState} looks at. */
export interface UpdatePageInput {
  /** The viewer holds platform.update (installs from the admin). */
  readonly canInstall: boolean;
  /** The viewer holds settings.write (may run the upgrade command). */
  readonly canUpgrade: boolean;
  readonly status: {
    readonly installedVersion: string;
    readonly latestVersion: string | null;
    readonly upgradeAvailable: boolean;
    readonly checkedAt: string | null;
    /** The newest release raises the infrastructure contract (#817); null = not known. */
    readonly infraChange: boolean | null;
  };
  /** The most recent update request, or null. */
  readonly request: {
    readonly status: PlatformUpdateStatusValue;
    readonly targetVersion: string;
    readonly fromVersion: string;
    readonly statusReason: string | null;
  } | null;
  /** The request's timeline. */
  readonly events: readonly { readonly phase: PlatformUpdatePhase }[];
  /** The request is `running` but its upgrader run is over (died without reporting); its log. */
  readonly deadRunLogsUrl: string | null;
  /** The auto-update scheduler's last decision. */
  readonly scheduler: {
    readonly lastAction: string | null;
    readonly lastVersion: string | null;
    readonly lastWaitUntil: string | null;
  };
  readonly installRoute: InstallRoute;
  readonly selfHosted: boolean;
  /**
   * The in-admin converge job exists (#819): a release that changes the
   * cloud setup installs from here like any other. Until then such a
   * release is a break-glass step in Cloud Shell.
   */
  readonly convergeJob: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "Oct 20 at 03:00 UTC": a day and time every Owner reads the same way, on
 * the server and in any browser (no locale-dependent Intl output, so the
 * server render and the hydrated page agree).
 */
export function utcDayTime(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} at ${d.toISOString().slice(11, 16)} UTC`;
}

/** The action that installs `version` for this viewer (`label` on the Install button). */
function installAction(input: UpdatePageInput, version: string, label: string): PrimaryAction {
  if (input.installRoute === "in_product") return { kind: "install", version, label };
  if (input.installRoute === "terminal") return { kind: "terminal", version };
  return { kind: "none" };
}

/**
 * Settings → Updates in one state: the first of {@link UPDATE_PAGE_STATES}
 * that applies, with one sentence and exactly one primary action. The
 * page renders only this; an Owner who has never heard of install.json or
 * an infrastructure contract can tell in five seconds whether they can
 * update, and how (CLAUDE.md §1A).
 *
 * A previous attempt counts only when it is about the release on offer
 * now (its target is the newest release, newer than what runs); older
 * ones live in the history.
 */
export function updatePageState(input: UpdatePageInput): UpdatePageState {
  const { status, request } = input;
  const installed = status.installedVersion;
  const latest = status.upgradeAvailable ? status.latestVersion : null;
  const active = request !== null && isActive(request.status) ? request : null;
  // The last attempt, only when it was about the release on offer now.
  const attempt =
    request !== null && latest !== null && request.targetVersion === latest && active === null
      ? request
      : null;
  const canAct = input.canInstall || input.canUpgrade;

  // 1. Someone else installs.
  if (!canAct && (latest !== null || active !== null)) {
    const target = active !== null ? active.targetVersion : latest;
    return {
      kind: "no_permission",
      badge: active
        ? { label: "Installing", tone: "secondary" }
        : { label: "Update available", tone: "warning" },
      sentence: active
        ? `An Owner is installing v${target}. Nothing changes for your work.`
        : `v${target} is available. An Owner of this site installs Caelo updates; nothing changes for your work until then.`,
      detail: null,
      action: { kind: "none" },
    };
  }

  // 2. An update runs (and its run is still alive).
  if (active !== null && input.deadRunLogsUrl === null) {
    return {
      kind: "in_progress",
      badge: STATUS_DISPLAY[active.status],
      sentence: progressSentence(active, input.events),
      detail: null,
      action: { kind: "timeline", cancellable: active.status === "pending" && input.canInstall },
    };
  }

  // 3. The last attempt at this release did not finish.
  if (active !== null && input.deadRunLogsUrl !== null) {
    return {
      kind: "interrupted",
      badge: { label: "Interrupted", tone: "destructive" },
      sentence: `The update to v${active.targetVersion} stopped without reporting back. Your site may still run v${installed}: open it to check.`,
      detail:
        "Once its run is cleared (within 90 minutes) you can try again from here. The upgrader's log shows where it stopped.",
      action: { kind: "logs", url: input.deadRunLogsUrl },
    };
  }
  if (latest !== null && (attempt?.status === "failed" || attempt?.status === "refused")) {
    const nothing = stoppedBeforeChange(input.events);
    return {
      kind: "interrupted",
      badge: { label: "Not installed", tone: "destructive" },
      sentence: nothing
        ? `The update to v${latest} stopped before it changed anything. Your site runs on v${installed}.`
        : `The update to v${latest} was interrupted. Your site runs on v${installed}.`,
      detail: attempt.statusReason,
      action: installAction(input, latest, "Try again…"),
    };
  }

  // 4. The new release failed its test and was undone.
  if (latest !== null && attempt?.status === "rolled_back") {
    return {
      kind: "rolled_back",
      badge: { label: "Rolled back", tone: "warning" },
      sentence: `v${latest} did not pass its test. Caelo switched back to v${installed}; your site is unchanged.`,
      detail: attempt.statusReason,
      action: installAction(input, latest, "Try again…"),
    };
  }

  // 5. Only the Owner's own account can do it: Cloud Shell (or, self-hosted,
  //    the server). Never next to an Install button for the same release.
  const askedForHand = attempt?.status === "needs_cloud_shell" ? attempt : null;
  const predictedConverge =
    latest !== null && status.infraChange === true && !input.convergeJob && !input.selfHosted;
  if (latest !== null && canAct && (askedForHand !== null || predictedConverge)) {
    const handAction: PrimaryAction = !input.canUpgrade
      ? { kind: "none" }
      : input.selfHosted
        ? { kind: "server_command", version: latest }
        : { kind: "cloud_shell", version: latest };
    const sentence = input.selfHosted
      ? `Caelo can't install v${latest} by itself. Run the upgrade command on your server once; after that, updates install from here again.`
      : askedForHand !== null
        ? `Caelo can't install v${latest} by itself. Install it once from Google Cloud Shell with your Google account; nothing on your site was changed.`
        : `v${latest} also changes settings in your Google Cloud project, which Caelo can't do by itself yet. Install it once from Google Cloud Shell with your Google account.`;
    return {
      kind: "break_glass",
      badge: { label: "Needs one step from you", tone: "warning" },
      sentence,
      detail: askedForHand?.statusReason ?? null,
      action: handAction,
    };
  }

  // 6./7. A newer release: installed automatically at a known time, or by hand.
  if (latest !== null) {
    const s = input.scheduler;
    const scheduled =
      s.lastAction === "wait" && s.lastVersion === latest && s.lastWaitUntil !== null;
    if (!scheduled) {
      return {
        kind: "update_available",
        badge: { label: "Update available", tone: "warning" },
        sentence: `v${latest} is available.`,
        detail:
          status.infraChange === true
            ? "This update also changes settings in your Google Cloud project, so it takes a little longer."
            : null,
        action: installAction(input, latest, `Install v${latest}…`),
      };
    }
    return {
      kind: "scheduled",
      badge: { label: "Scheduled", tone: "secondary" },
      sentence: `v${latest} installs automatically on ${utcDayTime(s.lastWaitUntil as string)}.`,
      detail: null,
      action: installAction(input, latest, "Install now…"),
    };
  }

  // 8. Nothing newer, and the check really reached GitHub.
  if (status.checkedAt !== null && status.latestVersion !== null) {
    return {
      kind: "up_to_date",
      badge: { label: "Up to date", tone: "success" },
      sentence: "Your site runs the newest version of Caelo.",
      detail: null,
      action: { kind: "none" },
    };
  }

  // 9. Never checked, or the last check failed: say so, never "up to date".
  return {
    kind: "unknown",
    badge:
      status.checkedAt === null
        ? { label: "Not checked yet", tone: "secondary" }
        : { label: "Last check failed", tone: "destructive" },
    sentence:
      status.checkedAt === null
        ? "Caelo hasn't checked for new releases yet. It checks once an hour."
        : "Caelo couldn't reach GitHub, so it doesn't know whether there is a new release. It tries again within the hour.",
    detail: null,
    action: { kind: "check_now" },
  };
}

/* ------------------------------------------------------------------------ */
/* One-line summaries of the collapsed sections (#861).                     */
/* ------------------------------------------------------------------------ */

/**
 * The automatic-update policy in one line. Takes the shared policy mode
 * type, so a change to the modes (#862 drops "off") is a type error here.
 */
export function autoUpdateModeLine(policy: {
  readonly mode: UpdatePolicyMode;
  readonly autoSecurity: boolean;
  readonly autoPatch: boolean;
  readonly autoMinor: boolean;
  readonly paused: boolean;
}): string {
  const paused = policy.paused ? " Paused right now." : "";
  if (policy.mode === "auto") {
    const kinds = [
      policy.autoSecurity && "security fixes",
      policy.autoPatch && "bug-fix releases",
      policy.autoMinor && "feature releases",
    ].filter((k): k is string => typeof k === "string");
    if (kinds.length === 0) {
      return `On, but no kind of release is chosen: you install everything yourself.${paused}`;
    }
    const list =
      kinds.length === 1 ? kinds[0] : `${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1)}`;
    return `Installs ${list} automatically.${paused}`;
  }
  if (policy.mode === "notify") return `You're notified and install updates yourself.${paused}`;
  return `Off: you see new releases only on this page.${paused}`;
}

/** The history in one line: the last attempt and how it ended, plus the count. */
export function historySummary(
  history: readonly { readonly requestedAt: string; readonly status: PlatformUpdateStatusValue }[],
  latestEvents: readonly { readonly phase: PlatformUpdatePhase }[],
  selfHosted: boolean,
): string {
  const last = history[0];
  if (!last) return "No updates installed from here yet.";
  const when = utcDayTime(last.requestedAt);
  const outcome =
    last.status === "failed" || last.status === "refused" || last.status === "needs_cloud_shell"
      ? finishLabel(last.status, latestEvents).toLowerCase()
      : statusDisplay(last.status, selfHosted).label.toLowerCase();
  const count = `${history.length} ${history.length === 1 ? "entry" : "entries"}`;
  return `Last attempt ${when}: ${outcome} · ${count}`;
}
