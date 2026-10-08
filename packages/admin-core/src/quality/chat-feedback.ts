// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — what the originating chat is told when its Stage's audit
 * settles. Pure; the chat endpoint claims the notification once
 * (`quality_audits.claim_chat_notification`) and the chat panel either
 * posts the text as a status note, or sends it as a system-origin turn so
 * the AI starts fixing.
 *
 * The 2-round cap (#553): the AI is asked to fix automatically while the
 * audit's `fixRound` is below MAX_AUTO_FIX_ROUNDS. After that it may only
 * summarise and ask for acceptances — no further changes for these
 * findings, so a stubborn finding cannot loop Stages and cost.
 */

/** Automatic fix rounds per Stage chain (#553). */
export const MAX_AUTO_FIX_ROUNDS = 2;

export interface ChatAuditSummary {
  readonly status:
    | "queued"
    | "running"
    | "passed"
    | "problems"
    | "errored"
    | "skipped"
    | "superseded";
  readonly fixRound: number;
  readonly problemCount: number;
  /** Paths of the pages with problems, homepage first. */
  readonly problemPagePaths: readonly string[];
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly skippedBecause: readonly string[];
}

export type ChatFeedback =
  /** Post as a status note; the AI is not asked to act. */
  | { readonly kind: "note"; readonly text: string }
  /** Send as a system-origin turn: the AI acts on it. */
  | { readonly kind: "ai-turn"; readonly text: string };

function pages(paths: readonly string[]): string {
  if (paths.length === 0) return "the audited pages";
  const shown = paths.slice(0, 4).join(", ");
  return paths.length > 4 ? `${shown} and ${paths.length - 4} more` : shown;
}

/**
 * The chat message for a settled audit, or null while it is still queued
 * or running (and for a superseded one: the newer Stage reports instead).
 */
export function chatFeedbackFor(audit: ChatAuditSummary): ChatFeedback | null {
  switch (audit.status) {
    case "queued":
    case "running":
    case "superseded":
      return null;
    case "passed":
      return {
        kind: "note",
        text: "Quality check passed (Performance, Accessibility, Best Practices, SEO) — Publish live is available.",
      };
    case "skipped":
      return {
        kind: "note",
        text: `No quality check needed for this Stage (${audit.skippedBecause.slice(0, 3).join("; ") || "no rendering changes"}) — Publish live is available.`,
      };
    case "errored":
      return {
        kind: "note",
        text: `Quality check failed: ${audit.errorMessage ?? audit.errorCode ?? "no reason recorded"}. Publish live stays blocked — retry the check, or an editor may publish anyway with a recorded reason.`,
      };
    case "problems": {
      const where = pages(audit.problemPagePaths);
      if (audit.fixRound < MAX_AUTO_FIX_ROUNDS) {
        return {
          kind: "ai-turn",
          text:
            `Quality check of the staged build found ${audit.problemCount} problem(s) on ${where}. Publish live is blocked until they are fixed or accepted. ` +
            `Fix round ${audit.fixRound + 1} of ${MAX_AUTO_FIX_ROUNDS}: call get_quality_audit for the findings, fix what you can, then ask me to Stage again so the fixes are re-checked. ` +
            "For anything you cannot fix, or that looks intended, ask me to accept it (accept_quality_findings) instead of changing the site.",
        };
      }
      return {
        kind: "ai-turn",
        text:
          `Quality check still found ${audit.problemCount} problem(s) on ${where} after ${MAX_AUTO_FIX_ROUNDS} automatic fix rounds. ` +
          "Do not change the site further for these findings. Call get_quality_audit, summarise what is left in plain words, and ask me whether to accept each one (accept_quality_findings) or leave Publish blocked.",
      };
    }
  }
}
