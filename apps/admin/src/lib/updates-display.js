// SPDX-License-Identifier: MPL-2.0
/**
 * Settings → Updates in plain language (#696, #861): the page's one state
 * (`updatePageState`) with its sentence and single primary action, what
 * each phase of an upgrader run and each end state means, and the one-line
 * summaries of the collapsed sections — for an Owner who has never heard of
 * a migration, a revision or install.json.
 */
import { isPausedAt, PLATFORM_UPDATE_STALE_MINUTES, } from "@caelo-cms/shared";
/**
 * The timeline's steps, in order (rollback only shows when it happened).
 * The last one, `finish`, is named by its outcome: {@link phaseLabel}.
 */
export const PHASE_LABELS = {
    queued: "Requested",
    start: "Upgrader started",
    verify: "Checking the release is genuine",
    assess: "Checking it fits this site",
    backup: "Backing up your database",
    converge: "Updating your cloud setup",
    "health-baseline": "Making sure the site can be tested",
    migrations: "Updating the database",
    roll: "Switching to the new version",
    health: "Testing the new version",
    rollback: "Going back to the previous version",
    record: "Recording the new version",
    "self-update": "Updating the updater",
};
/** Status badge text + tone. */
export const STATUS_DISPLAY = {
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
export function statusDisplay(status, selfHosted) {
    if (status === "needs_cloud_shell" && selfHosted) {
        return { label: "Needs a manual upgrade", tone: "warning" };
    }
    return STATUS_DISPLAY[status];
}
/** Whether a request is still in flight (the page keeps polling). */
export function isActive(status) {
    return status === "pending" || status === "running";
}
/**
 * How long ago the release check ran, in words: "just now", "40 min ago",
 * "3 h ago", "2 days ago". A time in the future (clock skew between the
 * database and this server) reads as "just now".
 */
export function checkedAgo(checkedAt, now) {
    const minutes = Math.floor((now.getTime() - new Date(checkedAt).getTime()) / 60_000);
    if (minutes < 1)
        return "just now";
    if (minutes < 60)
        return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours} h ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
}
/**
 * How old the last release check may be before "Your site runs the newest
 * version" stops being a claim the page can make. The worker checks every
 * hour and stamps failed checks too, so an answer this old means the check
 * is not running at all (worker off, admin crash-looping): the page says it
 * does not know instead of repeating a day-old "up to date".
 */
export const RELEASE_CHECK_STALE_MS = 24 * 60 * 60 * 1000;
/* ------------------------------------------------------------------------ */
/* How a run ended (#861): outcomes, not phases.                            */
/* ------------------------------------------------------------------------ */
/**
 * Phases in which the upgrader changes the install: from the database
 * migrations on. Everything before (signature, fit check, backup, the
 * health baseline) leaves the site as it was.
 */
const CHANGING_PHASES = new Set([
    "migrations",
    "roll",
    "health",
    "rollback",
    "record",
    "self-update",
]);
/** Whether a run's timeline shows it never reached a step that changes the install. */
export function stoppedBeforeChange(events) {
    return !events.some((e) => CHANGING_PHASES.has(e.phase));
}
/**
 * The label of a finished run's last timeline step: what came out of it.
 * A run refused before it changed anything never reads "Finished" (#861).
 */
export function finishLabel(status, events) {
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
export function phaseLabel(phase, status, events) {
    return phase === "finish" ? finishLabel(status, events) : PHASE_LABELS[phase];
}
/** The steps an Owner sees while an update runs, in order. */
const PROGRESS_STEPS = [
    // #819 — the converge job opens with `converge`, before its backup.
    { label: "checking the release", phases: ["verify", "assess", "converge"] },
    { label: "backing up your database", phases: ["backup", "health-baseline"] },
    { label: "updating the database", phases: ["migrations"] },
    { label: "switching to the new version", phases: ["roll"] },
    { label: "testing the new version", phases: ["health", "rollback", "record", "self-update"] },
];
/**
 * The one sentence for an update in flight: which step of how many, in
 * words. Recomputed from the live timeline while the page polls.
 */
export function progressSentence(request, events) {
    const leave = "You can leave this page.";
    let step = 0;
    for (const e of events) {
        const i = PROGRESS_STEPS.findIndex((s) => s.phases.includes(e.phase));
        if (i + 1 > step)
            step = i + 1;
    }
    if (request.status === "pending" || step === 0) {
        return `Caelo installs v${request.targetVersion} as soon as the upgrader starts. ${leave}`;
    }
    const current = PROGRESS_STEPS[step - 1];
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
];
/**
 * When the scheduler's "wait" decision for `latest` installs it, or null
 * when that decision no longer holds: the policy must still install
 * automatically, not be paused at `now`, and not have changed after the
 * decision was made, and the Owner must not have skipped the release.
 */
function scheduledInstall(input, latest) {
    const { scheduler: s, policy } = input;
    if (s.lastAction !== "wait" || s.lastVersion !== latest || s.lastWaitUntil === null)
        return null;
    // The Owner skipped it (#868): the skip op rewrites the decision too, but
    // the skip is what the scheduler acts on.
    if (s.skippedVersion === latest)
        return null;
    if (policy.mode !== "auto" || isPausedAt(policy, input.now))
        return null;
    if (s.lastRunAt === null || Date.parse(policy.updatedAt) > Date.parse(s.lastRunAt))
        return null;
    return s.lastWaitUntil;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/**
 * "Oct 20 at 03:00 UTC": a day and time every Owner reads the same way, on
 * the server and in any browser (no locale-dependent Intl output, so the
 * server render and the hydrated page agree).
 */
export function utcDayTime(iso) {
    const d = new Date(iso);
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} at ${d.toISOString().slice(11, 16)} UTC`;
}
/** The action that installs `version` for this viewer (`label` on the Install button). */
function installAction(input, version, label) {
    if (input.installRoute === "in_product")
        return { kind: "install", version, label };
    if (input.installRoute === "terminal")
        return { kind: "terminal", version };
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
export function updatePageState(input) {
    const { status, request } = input;
    const installed = status.installedVersion;
    const latest = status.upgradeAvailable ? status.latestVersion : null;
    const active = request !== null && isActive(request.status) ? request : null;
    // The last attempt, only when it was about the release on offer now.
    const attempt = request !== null && latest !== null && request.targetVersion === latest && active === null
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
    if (active !== null && input.deadRunLogsUrl !== null && input.deadRunContinuable) {
        return {
            kind: "interrupted",
            badge: { label: "Interrupted", tone: "destructive" },
            sentence: `The update to v${active.targetVersion} stopped before it finished. Continue it: Caelo picks up where it stopped.`,
            detail: "It keeps the backup it took before the update began, finishes what is left, tests the new version and goes back automatically if the test fails.",
            action: {
                kind: "continue",
                version: active.targetVersion,
                logsUrl: input.deadRunLogsUrl,
            },
        };
    }
    if (active !== null && input.deadRunLogsUrl !== null) {
        return {
            kind: "interrupted",
            badge: { label: "Interrupted", tone: "destructive" },
            sentence: `The update to v${active.targetVersion} stopped without reporting back. Your site may still run v${installed}: open it to check.`,
            detail: `Once its run is cleared (within ${PLATFORM_UPDATE_STALE_MINUTES} minutes of its start) you can try again from here. The upgrader's log shows where it stopped.`,
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
    // #819 — a cloud-setup change the upgrader handed back is no step by hand
    // when this install has the converge job: Install hands it to that job.
    const convergeInstead = input.convergeJob && (attempt?.refusalCodes.includes("infra-contract") ?? false);
    const askedForHand = attempt?.status === "needs_cloud_shell" && !convergeInstead ? attempt : null;
    const predictedConverge = latest !== null && status.infraChange === true && !input.convergeJob && !input.selfHosted;
    const needsHand = latest !== null && canAct && (askedForHand !== null || predictedConverge);
    if (needsHand && input.canUpgrade && !input.breakGlassAvailable) {
        // No such step for this install (another provider, or the upgrade
        // command can't be built): never point at a step that isn't there. The
        // page shows the upgrade path's diagnostic under the sentence.
        const missing = input.selfHosted
            ? "the upgrade command for your server can't be built"
            : "this install has no Cloud Shell upgrade";
        return {
            kind: "update_available",
            badge: { label: "Update available", tone: "warning" },
            sentence: `v${latest} is available.`,
            detail: askedForHand !== null
                ? `Caelo can't install it by itself, and ${missing}.${askedForHand.statusReason ? ` ${askedForHand.statusReason}` : ""}`
                : `It also changes settings in your cloud project, which Caelo can't do by itself yet, and ${missing}.`,
            action: { kind: "none" },
        };
    }
    if (latest !== null && needsHand && !input.canUpgrade) {
        // May install from here, but not run the step by hand (it needs
        // settings.write, which this role lacks): say who can, not how.
        return {
            kind: "break_glass",
            badge: { label: "Needs an Owner", tone: "warning" },
            sentence: `Caelo can't install v${latest} by itself. It needs one step by an Owner who may change this site's settings; ask them to open this page.`,
            detail: askedForHand?.statusReason ?? null,
            action: { kind: "none" },
        };
    }
    if (latest !== null && needsHand) {
        const handAction = input.selfHosted
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
        const scheduledAt = scheduledInstall(input, latest);
        if (scheduledAt === null) {
            return {
                kind: "update_available",
                badge: { label: "Update available", tone: "warning" },
                sentence: `v${latest} is available.`,
                detail: [
                    input.scheduler.skippedVersion === latest
                        ? "You skipped its automatic install: it waits for you here, and the next newer release installs automatically again."
                        : null,
                    status.infraChange === true
                        ? "This update also changes settings in your Google Cloud project, so it takes a little longer."
                        : null,
                ]
                    .filter((line) => line !== null)
                    .join(" ") || null,
                action: installAction(input, latest, `Install v${latest}…`),
            };
        }
        return {
            kind: "scheduled",
            badge: { label: "Scheduled", tone: "secondary" },
            sentence: `v${latest} installs automatically on ${utcDayTime(scheduledAt)}.`,
            detail: null,
            action: installAction(input, latest, "Install now…"),
            // Skipping changes what installs unattended: the Owner's permission.
            ...(input.canInstall ? { secondary: { kind: "skip", version: latest } } : {}),
        };
    }
    // 8. Nothing newer, and the check really reached GitHub — recently.
    const stale = status.checkedAt !== null &&
        input.now.getTime() - Date.parse(status.checkedAt) > RELEASE_CHECK_STALE_MS;
    if (status.checkedAt !== null && status.latestVersion !== null && !stale) {
        return {
            kind: "up_to_date",
            badge: { label: "Up to date", tone: "success" },
            sentence: "Your site runs the newest version of Caelo.",
            detail: null,
            action: { kind: "none" },
        };
    }
    // 9. Never checked, the last check failed, or it is too old to vouch for
    //    anything: say so, never "up to date".
    if (status.checkedAt === null) {
        return {
            kind: "unknown",
            badge: { label: "Not checked yet", tone: "secondary" },
            sentence: "Caelo hasn't checked for new releases yet. It checks once an hour.",
            detail: null,
            action: { kind: "check_now" },
        };
    }
    if (stale) {
        return {
            kind: "unknown",
            badge: { label: "Check out of date", tone: "warning" },
            sentence: `Caelo last checked for new releases ${checkedAgo(status.checkedAt, input.now)}, so it may not know about a newer one.`,
            detail: "It normally checks every hour. Check now; if this comes back tomorrow, the admin's release check isn't running.",
            action: { kind: "check_now" },
        };
    }
    return {
        kind: "unknown",
        badge: { label: "Last check failed", tone: "destructive" },
        sentence: "Caelo couldn't reach GitHub, so it doesn't know whether there is a new release. It tries again within the hour.",
        detail: null,
        action: { kind: "check_now" },
    };
}
/* ------------------------------------------------------------------------ */
/* One-line summaries of the collapsed sections (#861).                     */
/* ------------------------------------------------------------------------ */
/**
 * The automatic-update policy in one line. Takes the shared policy mode
 * type: "notify" is the only mode besides "auto" since #862 dropped "off".
 */
export function autoUpdateModeLine(policy) {
    const paused = policy.paused ? " Paused right now." : "";
    if (policy.mode === "auto") {
        const kinds = [
            policy.autoSecurity && "security fixes",
            policy.autoPatch && "bug-fix releases",
            policy.autoMinor && "feature releases",
        ].filter((k) => typeof k === "string");
        if (kinds.length === 0) {
            return `On, but no kind of release is chosen: you install everything yourself.${paused}`;
        }
        const list = kinds.length === 1 ? kinds[0] : `${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1)}`;
        return `Installs ${list} automatically.${paused}`;
    }
    return `You're notified and install updates yourself.${paused}`;
}
/** The history in one line: the last attempt and how it ended, plus the count. */
export function historySummary(history, latestEvents, selfHosted) {
    const last = history[0];
    if (!last)
        return "No updates installed from here yet.";
    const when = utcDayTime(last.requestedAt);
    const outcome = last.status === "failed" || last.status === "refused" || last.status === "needs_cloud_shell"
        ? finishLabel(last.status, latestEvents).toLowerCase()
        : statusDisplay(last.status, selfHosted).label.toLowerCase();
    const count = `${history.length} ${history.length === 1 ? "entry" : "entries"}`;
    return `Last attempt ${when}: ${outcome} · ${count}`;
}
