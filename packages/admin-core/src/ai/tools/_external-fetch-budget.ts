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
 */

const WINDOW_MS = 10 * 60 * 1000;
const MAX_FETCHES_PER_WINDOW = 12;

const usage = new Map<string, number[]>();

export interface FetchBudgetResult {
  readonly ok: boolean;
  readonly remaining: number;
}

/** Consume one external fetch from the session's rolling budget. */
export function takeExternalFetchBudget(sessionKey: string | undefined): FetchBudgetResult {
  const key = sessionKey ?? "no-session";
  const now = Date.now();
  const stamps = (usage.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (stamps.length >= MAX_FETCHES_PER_WINDOW) {
    usage.set(key, stamps);
    return { ok: false, remaining: 0 };
  }
  stamps.push(now);
  usage.set(key, stamps);
  return { ok: true, remaining: MAX_FETCHES_PER_WINDOW - stamps.length };
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
