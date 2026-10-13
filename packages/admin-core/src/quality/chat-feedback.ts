// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — what the originating chat is told when its Stage's audit
 * settles. Pure; the chat endpoint claims the notification once
 * (`quality_audits.claim_chat_notification`).
 *
 * Issue #685 — problems never start the AI on their own. They come back as
 * an `offer`: the chat panel shows a card ("Quality check found N issues on
 * M pages … Let the AI fix them?") and only the operator's "Fix with AI"
 * sends `prompt` as a turn. That holds for EVERY Stage — the operator's own,
 * another agent's, and the Live Edit AI's own stage_changes: nothing records
 * that the operator asked the AI to "stage and fix until green", and the
 * operator may have moved on while the check ran, so the chat always asks.
 * The prompt carries what the AI would otherwise have to guess: the findings
 * per page, who staged the build, and that the build may contain changes
 * made outside this conversation.
 *
 * The 2-round cap (#553): a fix round is offered while the audit's
 * `fixRound` is below MAX_AUTO_FIX_ROUNDS. After that the offer only asks
 * the AI to summarise what is left — no further changes for these findings,
 * so a stubborn finding cannot loop Stages and cost. It never recommends an
 * acceptance (#667): that decision is the operator's, and platform findings
 * are reported as Caelo bugs instead.
 */

import { z } from "zod";
import type { QualityProblem } from "./ratchet.js";

/** Fix rounds per Stage chain (#553). */
export const MAX_AUTO_FIX_ROUNDS = 2;

/** Who staged the build a chat's audit checks (#685, column `staged_by`). */
export const stagedBySchema = z.enum(["operator", "live_edit_ai", "other_agent"]);
export type StagedBy = z.infer<typeof stagedBySchema>;

/** One audited page with problems, as the chat is told about it. */
export interface ChatProblemPage {
  readonly path: string;
  /** Short, operator-readable labels of the page's problems. */
  readonly findings: readonly string[];
}

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
  /** Pages with problems, homepage first. */
  readonly problemPages: readonly ChatProblemPage[];
  /** Who staged the audited build; null when not recorded. */
  readonly stagedBy: StagedBy | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly skippedBecause: readonly string[];
}

export type ChatFeedback =
  /** Post as a status note; the AI is not asked to act. */
  | { readonly kind: "note"; readonly text: string }
  /**
   * Ask the operator (#685): `text` is the card, `actionLabel` its button,
   * `prompt` the turn the button sends. Never sent without that click.
   */
  | {
      readonly kind: "offer";
      readonly text: string;
      readonly actionLabel: string;
      readonly prompt: string;
    };

/** A short operator-readable label for one problem. */
export function problemLabel(p: QualityProblem): string {
  if (p.kind === "failing_audit") {
    return p.displayValue ? `${p.title} (${p.displayValue})` : p.title;
  }
  return `${p.category} score ${p.score} (was ${p.baseline})`;
}

function pageList(pages: readonly ChatProblemPage[]): string {
  if (pages.length === 0) return "the audited pages";
  const shown = pages
    .slice(0, 3)
    .map((p) => {
      const f = p.findings.slice(0, 2).join(", ");
      const more = p.findings.length > 2 ? ` +${p.findings.length - 2}` : "";
      return f ? `${p.path} (${f}${more})` : p.path;
    })
    .join("; ");
  return pages.length > 3 ? `${shown}; and ${pages.length - 3} more page(s)` : shown;
}

/** Every finding per page, for the AI (bounded so a huge audit stays readable). */
function findingsBlock(pages: readonly ChatProblemPage[]): string {
  const lines = pages.slice(0, 10).map((p) => {
    const more = p.findings.length > 8 ? `; +${p.findings.length - 8} more` : "";
    return `- ${p.path}: ${p.findings.slice(0, 8).join("; ")}${more}`;
  });
  if (pages.length > 10) lines.push(`- … and ${pages.length - 10} more page(s)`);
  return lines.join("\n");
}

function stagedByCard(stagedBy: StagedBy | null): string {
  switch (stagedBy) {
    case "operator":
      return "Staged by you.";
    case "live_edit_ai":
      return "Staged by the AI in this chat.";
    case "other_agent":
      return "Staged by another agent working in this chat.";
    case null:
      return "";
  }
}

function stagedByOrigin(stagedBy: StagedBy | null): string {
  switch (stagedBy) {
    case "operator":
      return "I staged this build myself (Stage button or Open changes), not you during a turn.";
    case "live_edit_ai":
      return "You staged this build with stage_changes in an earlier turn of this chat.";
    case "other_agent":
      return "Another agent staged this build (an external MCP agent working in this chat, or a subagent) — not you in this conversation.";
    case null:
      return "It is not recorded who staged this build.";
  }
}

function stagedByPrompt(stagedBy: StagedBy | null): string {
  return (
    `${stagedByOrigin(stagedBy)} The staged build can also contain changes made outside this conversation (other chats staged together, another agent, or me), ` +
    "so do not assume you made everything on these pages: look at the page (get_quality_audit names the flagged elements) before changing it, and do not undo work someone else made on purpose."
  );
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
    case "problems":
      return problemsOffer(audit);
  }
}

function problemsOffer(audit: ChatAuditSummary): ChatFeedback {
  const pageCount = audit.problemPages.length;
  const summary = `Quality check found ${audit.problemCount} issue(s) on ${pageCount} page(s): ${pageList(audit.problemPages)}.`;
  const who = stagedByCard(audit.stagedBy);
  const lead = who ? `${summary} ${who}` : summary;
  const findings =
    `Quality check of the staged build found ${audit.problemCount} problem(s) on ${pageCount} page(s). Publish live is blocked until they are fixed or accepted.\n` +
    `Findings:\n${findingsBlock(audit.problemPages)}\n` +
    stagedByPrompt(audit.stagedBy);
  if (audit.fixRound < MAX_AUTO_FIX_ROUNDS) {
    return {
      kind: "offer",
      text: `${lead} Publish live stays blocked until they are fixed or accepted. Let the AI fix them?`,
      actionLabel: "Fix with AI",
      prompt:
        `Please fix the quality findings. ${findings}\n` +
        `Fix round ${audit.fixRound + 1} of ${MAX_AUTO_FIX_ROUNDS}: call get_quality_audit for the details, fix what you can, then Stage again yourself (stage_changes) so the fixes are re-checked. ` +
        "Findings marked CAELO PLATFORM are Caelo bugs: report them with bug_report and do not change the site for them. For anything else you cannot fix, or that looks intended, tell me plainly what it is. " +
        "Do not propose or recommend accepting findings — accepting is my decision; use accept_quality_findings only when I explicitly ask for it.",
    };
  }
  return {
    kind: "offer",
    text: `${lead} They are left after ${MAX_AUTO_FIX_ROUNDS} fix rounds; Publish live stays blocked until they are fixed or accepted. Let the AI summarise what is left?`,
    actionLabel: "Summarise with AI",
    prompt:
      `${findings}\n` +
      `These are left after ${MAX_AUTO_FIX_ROUNDS} fix rounds. Do not change the site further for these findings. Call get_quality_audit and summarise what is left in plain words — without recommending to accept anything. Report findings marked CAELO PLATFORM with bug_report and tell me they are Caelo issues you reported. ` +
      "Tell me Publish live stays blocked until they are fixed or I decide to accept them; use accept_quality_findings only when I explicitly ask for it.",
  };
}
