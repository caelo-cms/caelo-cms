// SPDX-License-Identifier: MPL-2.0

/**
 * Pure, side-effect-free decision helpers for `imports.compose_from_run`
 * (ops/imports.ts). Kept out of the DB-coupled handler so the two
 * failure classes the migration chat kept hitting are unit-testable in
 * isolation:
 *
 *  1. "run is crawling" surfaced as a RED error card even though the
 *     background crawl simply had not reached `ready_for_review` yet —
 *     expected timing, not a failure. `classifyComposeRunStatus` turns
 *     the still-crawling / not-yet-started states into a structured
 *     "not ready, keep polling" outcome the op returns as `ok`, while a
 *     genuinely FAILED or unknown run stays a loud error.
 *
 *  2. Compose created per-cluster TEMPLATES but SILENTLY zero PAGES,
 *     leaving the AI to invent a "format reason" and fall back to the
 *     fragile direct-build path. `composePageSkipReason` names WHY a
 *     staging page is skipped, and `buildZeroPagesAbortMessage` builds
 *     the loud abort the handler throws when templates were created but
 *     no page survived the per-page gates (CLAUDE.md §2 — no silent
 *     degradation: fail loudly pointing at what's missing).
 */

/** How long the runner should wait before re-checking `imports.get`. */
export const COMPOSE_CRAWL_RETRY_MS = 5_000;

/**
 * The verdict for whether a run in a given status can be composed.
 *  - `compose`   — ready_for_review / completed: proceed.
 *  - `not_ready` — crawling / proposed: the crawl has not finished; the
 *                  caller should return `ok` with this so the AI keeps
 *                  polling instead of showing a red card.
 *  - `error`     — failed / unknown: a genuine, loud failure.
 */
export type ComposeRunClassification =
  | { kind: "compose" }
  | { kind: "not_ready"; runStatus: "crawling" | "proposed"; retryAfterMs: number }
  | { kind: "error"; message: string };

/**
 * Classify an `import_runs.status` for compose eligibility.
 *
 * @param status the run's current `status` column value
 * @param runId  the run id, quoted into the error message so a failed
 *               run points the AI at the exact row to inspect
 */
export function classifyComposeRunStatus(status: string, runId: string): ComposeRunClassification {
  if (status === "ready_for_review" || status === "completed") {
    return { kind: "compose" };
  }
  if (status === "crawling" || status === "proposed") {
    return { kind: "not_ready", runStatus: status, retryAfterMs: COMPOSE_CRAWL_RETRY_MS };
  }
  // "failed" or any unexpected value — the crawl will never reach
  // ready_for_review on its own, so composing is a hard error.
  return {
    kind: "error",
    message:
      `import run ${runId} is '${status}', not composable — the crawl did not reach ready_for_review. ` +
      `Check imports.get for the failure reason and re-run propose_site_import if it failed.`,
  };
}

/** A staging page the compose handler skipped, with the reason it did. */
export interface ComposeSkip {
  importPageId: string;
  slug: string;
  sourceUrl: string;
  reason: string;
}

/** The per-page fields the skip gate reads (subset of `import_pages`). */
export interface ComposePageGateInput {
  id: string;
  proposed_slug: string;
  source_url: string;
  diff_status: "pass" | "warn" | "fail" | null;
  acknowledged_at: string | Date | null;
}

/**
 * Decide whether a staging page must be SKIPPED during compose, and if
 * so, WHY. Returns `null` when the page should be composed.
 *
 * The only skip is the screenshot-fidelity gate, matching
 * `imports.accept_page`: a page whose rebuild diverged too far from the
 * source screenshot (`diff_status='fail'`) is held back until the
 * operator acknowledges it — promoting a visually-wrong page silently
 * would be worse than pausing. Unlike the pre-fix handler, the reason is
 * captured so a run that skips EVERY page fails loudly instead of
 * returning a misleading templates-but-zero-pages "success".
 */
export function composePageSkipReason(page: ComposePageGateInput): ComposeSkip | null {
  if (page.diff_status === "fail" && !page.acknowledged_at) {
    return {
      importPageId: page.id,
      slug: page.proposed_slug,
      sourceUrl: page.source_url,
      reason:
        "screenshot-diff FAIL not acknowledged — the rebuilt page diverged too far from the source. " +
        "Acknowledge the diff or exclude this page (includeImportPageIds), then re-run compose.",
    };
  }
  return null;
}

/**
 * Build the loud abort message for the "templates but zero pages" case:
 * compose minted per-cluster templates but every eligible page was
 * skipped, so nothing usable was produced. The handler throws with this
 * (rolling the whole transaction back) rather than returning an `ok`
 * result with `pageIds: []` — CLAUDE.md §2 forbids silent degradation.
 */
export function buildZeroPagesAbortMessage(templateCount: number, skipped: ComposeSkip[]): string {
  const reasons =
    skipped.length > 0
      ? skipped.map((s) => `'${s.slug}' (${s.sourceUrl}): ${s.reason}`).join("; ")
      : "no eligible pages passed the per-page gates.";
  return (
    `compose created ${templateCount} template(s) but ZERO pages — every eligible page was skipped, ` +
    `so nothing was applied (the whole compose was rolled back). Reasons: ${reasons} ` +
    `Resolve these and re-run compose.`
  );
}
