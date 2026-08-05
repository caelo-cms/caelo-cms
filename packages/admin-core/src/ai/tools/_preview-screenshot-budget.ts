// SPDX-License-Identifier: MPL-2.0

/**
 * issue #412 — rate cap for the SERVER-SIDE `screenshot_page` backend, so
 * a screenshot-happy agent (Power-MCP caller, headless send_chat turn, or
 * a subagent wave) cannot flood the in-process Chromium renderer. The
 * operator-browser SSE path is uncapped — the operator's own machine does
 * that work and their presence bounds it.
 *
 * Same shape as `_external-fetch-budget.ts`: keyed by chat session
 * (process-wide key outside a chat) with a rolling window — no turn
 * identity exists at this layer, and the window is what actually protects
 * the renderer (a "per turn" counter would reset on every loop iteration
 * of a runaway agent anyway).
 *
 * The ceiling fits real review flows: a page check is desktop + mobile
 * (2 captures), so 24 per window is ~12 page checks in 10 minutes —
 * far above legitimate use, far below a flood.
 */

const WINDOW_MS = 10 * 60 * 1000;
const MAX_CAPTURES_PER_WINDOW = 24;

const usage = new Map<string, number[]>();

export interface PreviewScreenshotBudgetResult {
  readonly ok: boolean;
  readonly remaining: number;
}

/** Consume one server-side capture from the session's rolling budget. */
export function takePreviewScreenshotBudget(
  sessionKey: string | undefined,
): PreviewScreenshotBudgetResult {
  const key = sessionKey ?? "no-session";
  const now = Date.now();
  const stamps = (usage.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (stamps.length >= MAX_CAPTURES_PER_WINDOW) {
    usage.set(key, stamps);
    return { ok: false, remaining: 0 };
  }
  stamps.push(now);
  usage.set(key, stamps);
  return { ok: true, remaining: MAX_CAPTURES_PER_WINDOW - stamps.length };
}

/** Test hook — budgets are process-global state. */
export function resetPreviewScreenshotBudgetForTests(): void {
  usage.clear();
}
