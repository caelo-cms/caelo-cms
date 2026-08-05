// SPDX-License-Identifier: MPL-2.0

/**
 * issue #189 — shared budget for the single-page external-sensing
 * tools (`inspect_external_page`, `screenshot_external_page`). These
 * exist for the cheap "glance" that starts a migration conversation;
 * whole-site work belongs to the Owner-gated crawl. The budget keeps a
 * runaway loop (or a prompt-injected page convincing the model to
 * enumerate URLs) from turning the glance into an unbounded scanner.
 *
 * Keyed by chat session (falls back to a process-wide key outside a
 * chat) with a rolling window — no turn identity exists at this layer.
 *
 * issue #423 — the limit is operator-tunable via the
 * `CAELO_LIVE_INSPECT_FETCH_BUDGET` env var (fetches per 10-minute
 * rolling window), and every denial is AI-actionable: it names the
 * limit, when the next fetch frees up, and the knob (CLAUDE.md §11
 * failure surfaces). The env var is read per call so tests — and a
 * restarted admin app — pick changes up without cache invalidation.
 */

const WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX_FETCHES_PER_WINDOW = 12;

/** Env knob for the per-session live-inspect fetch limit (issue #423). */
export const LIVE_INSPECT_BUDGET_ENV_VAR = "CAELO_LIVE_INSPECT_FETCH_BUDGET";

/**
 * Resolve the per-window fetch limit: the env knob when set, else the
 * default (12). A present-but-invalid value throws loudly naming the
 * variable (no-fallbacks pre-1.0 — a typo'd knob must not silently
 * revert to the default the operator meant to change).
 */
export function externalFetchBudgetLimit(): number {
  const raw = process.env[LIVE_INSPECT_BUDGET_ENV_VAR];
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_FETCHES_PER_WINDOW;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `${LIVE_INSPECT_BUDGET_ENV_VAR} must be a positive integer (fetches per 10-minute window); got "${raw}". ` +
        "Fix or unset the variable and restart the admin app.",
    );
  }
  return n;
}

const usage = new Map<string, number[]>();

export interface FetchBudgetResult {
  readonly ok: boolean;
  readonly remaining: number;
  /** The effective per-window limit (env knob or default). */
  readonly limit: number;
  /** The rolling window length, for message formatting. */
  readonly windowMinutes: number;
  /** On denial: seconds until the oldest counted fetch ages out and one
   *  fetch frees up. Absent when `ok`. */
  readonly retryAfterSeconds?: number;
}

/** Consume one external fetch from the session's rolling budget. */
export function takeExternalFetchBudget(sessionKey: string | undefined): FetchBudgetResult {
  const key = sessionKey ?? "no-session";
  const limit = externalFetchBudgetLimit();
  const windowMinutes = WINDOW_MS / 60_000;
  const now = Date.now();
  const stamps = (usage.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (stamps.length >= limit) {
    usage.set(key, stamps);
    const oldest = Math.min(...stamps);
    return {
      ok: false,
      remaining: 0,
      limit,
      windowMinutes,
      retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000)),
    };
  }
  stamps.push(now);
  usage.set(key, stamps);
  return { ok: true, remaining: limit - stamps.length, limit, windowMinutes };
}

/**
 * issue #423 — the shared, AI-actionable denial sentence (CLAUDE.md §11:
 * errors carry the next step). Tools append their own "what to do
 * instead" tail — this part states limit, reset window, and the knob.
 */
export function describeFetchBudgetDenied(b: FetchBudgetResult): string {
  const retry =
    b.retryAfterSeconds !== undefined
      ? `the next fetch frees up in ~${b.retryAfterSeconds}s`
      : "wait for the window to roll over";
  return (
    `External-fetch budget exhausted for this chat session: ${b.limit} live fetches per ` +
    `${b.windowMinutes}-minute rolling window; ${retry}. Operators can raise the limit via the ` +
    `${LIVE_INSPECT_BUDGET_ENV_VAR} env var (fetches per ${b.windowMinutes}-minute window; ` +
    "restart the admin app to apply)."
  );
}

/** Test hook — budgets are process-global state. */
export function resetExternalFetchBudgetForTests(): void {
  usage.clear();
}

/**
 * issue #191/#189 — the same explicit exemption list the orchestrator
 * uses: exact hostnames the SSRF guard lets through (e2e fixture
 * servers). Read per call so tests can toggle it.
 */
export function externalFetchAllowedHosts(): readonly string[] {
  return (process.env.CAELO_IMPORTER_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}
