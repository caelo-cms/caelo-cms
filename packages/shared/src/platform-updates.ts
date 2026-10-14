// SPDX-License-Identifier: MPL-2.0

/**
 * In-product Caelo updates (epic #696): the vocabulary the admin (Settings →
 * Updates, the `platform_updates.*` ops), the upgrader job and the Phase 5
 * scheduler share. One module so the timeline the page renders, the states
 * the job writes and the database CHECK constraints (migration 0267) agree.
 */

import { z } from "zod";

/** Every state of an update request (`platform_update_requests.status`). */
export const PLATFORM_UPDATE_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "rolled_back",
  "failed",
  "refused",
  "needs_cloud_shell",
  "cancelled",
] as const;
export type PlatformUpdateStatusValue = (typeof PLATFORM_UPDATE_STATUSES)[number];

/** States in which a request is still in flight (at most one at a time). */
export const ACTIVE_UPDATE_STATUSES: readonly PlatformUpdateStatusValue[] = ["pending", "running"];

/** Whether `status` is an end state. */
export function isFinishedUpdateStatus(status: PlatformUpdateStatusValue): boolean {
  return !ACTIVE_UPDATE_STATUSES.includes(status);
}

/**
 * The phases of an upgrader run, in order (`platform_update_events.phase`).
 * `rollback` only appears when a roll had to be undone.
 */
export const PLATFORM_UPDATE_PHASES = [
  "queued",
  "start",
  "verify",
  "assess",
  "backup",
  "health-baseline",
  "migrations",
  "roll",
  "health",
  "rollback",
  "record",
  "self-update",
  "finish",
] as const;
export type PlatformUpdatePhase = (typeof PLATFORM_UPDATE_PHASES)[number];

/** Severity of one timeline line. */
export const PLATFORM_UPDATE_EVENT_LEVELS = ["info", "success", "warn", "error"] as const;
export type PlatformUpdateEventLevel = (typeof PLATFORM_UPDATE_EVENT_LEVELS)[number];

/** Who started a request: the Owner's click, or the Phase 5 scheduler. */
export const PLATFORM_UPDATE_TRIGGERS = ["manual", "auto"] as const;
export type PlatformUpdateTrigger = (typeof PLATFORM_UPDATE_TRIGGERS)[number];

/**
 * A run still `running` this long after it started died (the upgrader job's
 * task timeout is 60 minutes). The next job run, and the next install
 * request, end it as failed — so a crashed run never blocks updates.
 */
export const PLATFORM_UPDATE_STALE_MINUTES = 90;

/** Why a stale run was ended (shown on its timeline). */
export const PLATFORM_UPDATE_STALE_REASON =
  "The upgrader stopped before it finished (its run timed out or crashed). The previous release may still serve, or the new one may be partly rolled out: open the site, and if it misbehaves run the upgrade once with Cloud Shell.";

/** Longest an event message may be (DB CHECK). */
export const PLATFORM_UPDATE_EVENT_MAX = 4000;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** A SemVer release version without a leading `v` (`0.11.0`, `0.11.0-rc.1`). */
export const releaseVersionSchema = z
  .string()
  .regex(SEMVER, "expected a release version like 0.11.0 (no leading v)");

/** How big a step from `from` to `to` is, by SemVer position. */
export type UpdateKind = "major" | "minor" | "patch";

/**
 * Classify the step from the installed release to a newer one.
 *
 * @returns null when `to` is not newer than `from` or either is not SemVer.
 * @example updateKind("0.10.45", "0.10.46") // → "patch"
 */
export function updateKind(from: string, to: string): UpdateKind | null {
  const a = SEMVER.exec(from);
  const b = SEMVER.exec(to);
  if (!a || !b) return null;
  const [fa, fb, fc] = [Number(a[1]), Number(a[2]), Number(a[3])];
  const [ta, tb, tc] = [Number(b[1]), Number(b[2]), Number(b[3])];
  if (ta !== fa) return ta > fa ? "major" : null;
  if (tb !== fb) return tb > fb ? "minor" : null;
  if (tc !== fc) return tc > fc ? "patch" : null;
  // Same X.Y.Z: a stable release over its own pre-release, or a later
  // pre-release (rc.1 → rc.2), is a step.
  if (a[4] === undefined) return null;
  if (b[4] === undefined) return "patch";
  return comparePrerelease(b[4], a[4]) > 0 ? "patch" : null;
}

/** SemVer §11 precedence of two pre-release identifier lists. */
function comparePrerelease(x: string, y: string): number {
  const xs = x.split(".");
  const ys = y.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const p = xs[i];
    const q = ys[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** The automatic-update modes. */
export const UPDATE_POLICY_MODES = ["off", "notify", "auto"] as const;
export type UpdatePolicyMode = (typeof UPDATE_POLICY_MODES)[number];

/** Release channels a policy may follow (only `stable` installs automatically). */
export const UPDATE_POLICY_CHANNELS = ["stable", "rc", "beta", "alpha"] as const;

const WALL_CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Whether `tz` is an IANA time zone this runtime knows. */
export function isKnownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The Owner's automatic-update policy (`platform_update_policy`), as the
 * ops read and write it. Major releases have no toggle: they are never
 * installed automatically before 1.0.
 */
export const updatePolicySchema = z
  .object({
    mode: z.enum(UPDATE_POLICY_MODES),
    autoSecurity: z.boolean(),
    autoPatch: z.boolean(),
    autoMinor: z.boolean(),
    channel: z.enum(UPDATE_POLICY_CHANNELS),
    /** `HH:MM` local time in `windowTimezone`, or null with windowEnd null = any time. */
    windowStart: z.string().regex(WALL_CLOCK, "expected HH:MM").nullable(),
    windowEnd: z.string().regex(WALL_CLOCK, "expected HH:MM").nullable(),
    windowTimezone: z.string().min(1).max(64).refine(isKnownTimeZone, "unknown time zone"),
    /** Hours after publication before a non-security release installs automatically. */
    soakHours: z.number().int().min(0).max(720),
    /**
     * The same for a release whose signed manifest names a published GitHub
     * Security Advisory (auto-update.ts `isSecurityRelease`). Shorter by
     * default (2 h vs 24 h): the fix is public, so every hour unpatched is
     * exposure, while two hours still let a broken release be pulled first.
     */
    securitySoakHours: z.number().int().min(0).max(720),
  })
  .strict()
  .refine((p) => (p.windowStart === null) === (p.windowEnd === null), {
    message: "set both ends of the maintenance window, or neither",
  })
  .refine((p) => p.mode !== "auto" || p.channel === "stable", {
    message: "automatic installs follow the stable channel only",
  })
  .refine((p) => p.securitySoakHours <= p.soakHours, {
    message: "security fixes cannot wait longer than other releases",
  });
export type UpdatePolicy = z.infer<typeof updatePolicySchema>;

/** The policy plus its pause state, as stored. */
export interface StoredUpdatePolicy extends UpdatePolicy {
  readonly paused: boolean;
  readonly pausedReason: string | null;
  readonly pausedAt: string | null;
  /** End of the Owner's pause; null = until resumed (or not paused). */
  readonly pausedUntil: string | null;
  /** True when the Owner paused; false when the upgrader paused after a failure. */
  readonly pausedByOwner: boolean;
  readonly updatedAt: string;
}

/** Minutes since local midnight of `at` in `timeZone`. */
function localMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return n("hour") * 60 + n("minute");
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Whether `at` falls inside the policy's maintenance window. A window whose
 * end is before its start spans midnight (`22:00`–`04:00`).
 */
export function inMaintenanceWindow(
  policy: Pick<UpdatePolicy, "windowStart" | "windowEnd" | "windowTimezone">,
  at: Date,
): boolean {
  if (policy.windowStart === null || policy.windowEnd === null) return true;
  const now = localMinutes(at, policy.windowTimezone);
  const start = toMinutes(policy.windowStart);
  const end = toMinutes(policy.windowEnd);
  if (start === end) return true;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** What the policy needs to know about a release to decide on an automatic install. */
export interface AutoInstallCandidate {
  readonly kind: UpdateKind;
  /** From the signed manifest AND auto-installable (assessAutoInstall's `kind`). */
  readonly security: boolean;
  /** Manifest `migrations.contract` (or a skipped contract release). */
  readonly contractMigrations: boolean;
  /** The release's channel. */
  readonly channel: string;
}

/**
 * Whether the policy lets the upgrader install `candidate` unattended at
 * `at` — the job's check for `trigger = 'auto'` requests (the scheduler
 * applies the soak period before it ever queues one).
 *
 * @returns null when allowed, else the reason in plain words
 */
export function autoInstallRefusal(
  policy: Pick<
    StoredUpdatePolicy,
    | "mode"
    | "autoSecurity"
    | "autoPatch"
    | "autoMinor"
    | "paused"
    | "pausedUntil"
    | "windowStart"
    | "windowEnd"
    | "windowTimezone"
  >,
  candidate: AutoInstallCandidate,
  at: Date,
): string | null {
  if (policy.mode !== "auto") return "automatic installs are switched off in the update policy";
  // An Owner pause with an end that has passed no longer holds (the
  // scheduler lifts it on its next tick; this keeps the job consistent).
  if (
    policy.paused &&
    (policy.pausedUntil === null || Date.parse(policy.pausedUntil) > at.getTime())
  ) {
    return "automatic installs are paused";
  }
  if (candidate.channel !== "stable") return "only stable releases install automatically";
  if (candidate.contractMigrations) {
    return "the release carries destructive database changes; the Owner installs it by hand";
  }
  if (candidate.kind === "major") return "major releases never install automatically";
  const allowed =
    (candidate.security && policy.autoSecurity) ||
    (candidate.kind === "patch" && policy.autoPatch) ||
    (candidate.kind === "minor" && policy.autoMinor);
  if (!allowed) {
    return `the policy does not install ${candidate.security ? "security fixes or " : ""}${candidate.kind} releases automatically`;
  }
  if (!inMaintenanceWindow(policy, at)) return "outside the maintenance window";
  return null;
}

/**
 * How long a verified Google sign-in authorizes one guarded action. Long
 * enough to read the confirmation dialog, short enough that an unattended
 * browser is useless soon after.
 */
export const STEP_UP_MAX_AGE_SECONDS = 600;

/** What a step-up is for (`step_up_challenges.purpose`). */
export const STEP_UP_PURPOSES = ["platform_update", "update_policy", "step_up_client"] as const;
export type StepUpPurpose = (typeof STEP_UP_PURPOSES)[number];
