// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — what the originating chat is told when its Stage's audit
 * settles. Pure; the chat endpoint claims the notification once
 * (`quality_audits.claim_chat_notification`).
 *
 * Issue #685 — problems never start the AI on their own. They come back as
 * an `offer`: the chat panel shows a card ("Quality check found N issues on
 * M pages … Let the AI fix them?") and only the operator's "Fix with AI"
 * sends `prompt` as a turn. That holds for every Stage the operator did not
 * hand to the AI — their own, another agent's, and a Live Edit AI Stage
 * nobody asked to fix: the operator may have moved on while the check ran,
 * so the chat asks. The prompt carries what the AI would otherwise have to
 * guess: the findings per page, who staged the build, and that the build
 * may contain changes made outside this conversation.
 *
 * One click fixes until the target (#771): once the operator clicked "Fix
 * all with AI", the AI's own re-Stage of that fix round continues on its own
 * (`autoContinue`) — the operator already said "fix them", and asking again
 * after every round turned "fix until 100" into a click per round. It
 * continues only while each round gets closer to the target (`madeProgress`:
 * fewer open problems, or as many with less score shortfall); a round that
 * does not stops the loop and the card asks the operator again. Two hard
 * bounds stop it as well, whatever the progress: MAX_AUTO_FIX_ROUNDS rounds
 * per chain, and AUTO_FIX_COST_CAP_MICROCENTS of AI spend in the chat since
 * the operator's click (no unbounded AI spend on one click, CLAUDE.md §4).
 * Past either, every further round needs the operator's click again. A
 * picked fix ("leave the others alone") never continues on its own, and the
 * panel's Stop latch (#672) holds it back.
 *
 * #727 "optimum, not good enough": the target is 100 and zero findings, and
 * the card groups the OPEN problems by rule across pages. Per group the
 * operator lets the AI fix it, accepts it (an editor's acceptance with a
 * reason — never the AI's), or picks pages. Every fix request repeats the
 * target to the AI; only what truly cannot be fixed comes back to the
 * operator, as one decision per group.
 */

import { z } from "zod";
import type { OpenProblem } from "./gate.js";
import { groupSummaryLine, type ProblemGroup } from "./problem-groups.js";
import { QUALITY_TARGET } from "./ratchet.js";

/** How far an audit's open problems are from the target (#771). */
export interface FixDistance {
  /** Open problems, one per rule and page. */
  readonly openCount: number;
  /** Lighthouse score points below the target, summed over pages. */
  readonly scoreShortfall: number;
}

/** The distance of a set of open problems from the target. */
export function fixDistance(open: readonly OpenProblem[]): FixDistance {
  let scoreShortfall = 0;
  for (const o of open) {
    if (o.problem.kind === "score_below_baseline") {
      scoreShortfall += Math.max(0, QUALITY_TARGET - o.problem.score);
    }
  }
  return { openCount: open.length, scoreShortfall };
}

/**
 * #771 — the most fix rounds one "Fix all with AI" click runs on its own:
 * the audit of the AI's re-Stage continues only while its fix round is
 * below this. Counted by `quality_audit_runs.fix_round` (the operator's
 * click starts round 1).
 */
export const MAX_AUTO_FIX_ROUNDS = 5;

/**
 * #771 — the most AI spend (microcents, 1 USD = 1e8) the chat may use
 * since the operator's "Fix all with AI" click before the next round needs
 * a click again. Summed from `ai_calls` of the chat, subagents included.
 */
export const AUTO_FIX_COST_CAP_MICROCENTS = 5 * 100_000_000;

function usd(microcents: number): string {
  return `$${(microcents / 100_000_000).toFixed(2)}`;
}

/** Whether a fix round got closer to the target: fewer open problems, or
 *  as many with fewer score points missing. */
export function madeProgress(before: FixDistance, after: FixDistance): boolean {
  if (after.openCount !== before.openCount) return after.openCount < before.openCount;
  return after.scoreShortfall < before.scoreShortfall;
}

function describeDistance(d: FixDistance): string {
  const shortfall =
    d.scoreShortfall > 0 ? `, ${d.scoreShortfall} score point(s) below ${QUALITY_TARGET}` : "";
  return `${d.openCount} open problem(s)${shortfall}`;
}

/** Who staged the build a chat's audit checks (#685, column `staged_by`). */
export const stagedBySchema = z.enum(["operator", "live_edit_ai", "other_agent"]);
export type StagedBy = z.infer<typeof stagedBySchema>;

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
  /** Who staged the audited build; null when not recorded. */
  readonly stagedBy: StagedBy | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly skippedBecause: readonly string[];
  /** #727 — whether Lighthouse ran (the page checks run on every Stage). */
  readonly lighthouse: boolean;
  /** #727 — the OPEN problems (no live acceptance covers them) grouped by
   *  rule across pages; the card offers fix / accept / pick per group. */
  readonly groups: readonly ProblemGroup[];
  /**
   * #771 — set when this audit checks the Live Edit AI's re-Stage of a fix
   * round the operator asked for in full ("Fix all with AI" on the chat's
   * previous audit): the distance before that round and now. Null otherwise.
   */
  readonly fixChain: {
    readonly before: FixDistance;
    readonly now: FixDistance;
    /** AI spend of the chat since the click that started the chain. */
    readonly spentMicrocents: number;
  } | null;
}

export type ChatFeedback =
  /** Post as a status note; the AI is not asked to act. */
  | { readonly kind: "note"; readonly text: string }
  /**
   * Ask the operator (#685): `text` is the card, `actionLabel` its button,
   * `prompt` the turn the button sends. Sent without a click only when
   * `autoContinue` (#771: the next round of a fix-all the operator started).
   */
  | {
      readonly kind: "offer";
      readonly text: string;
      readonly actionLabel: string;
      readonly prompt: string;
      /** #727 — the open problems per group: "fix all", "accept all" (an
       *  editor's acceptance with a reason) or "pick pages" each. */
      readonly groups: ProblemGroup[];
      readonly autoContinue: boolean;
    };

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
        text: audit.lighthouse
          ? "Quality check passed (page checks; Lighthouse: Performance, Accessibility, Best Practices, SEO) — Publish live is available."
          : `Quality check passed (page checks on every page; no Lighthouse audit needed: ${audit.skippedBecause.slice(0, 3).join("; ") || "no rendering changes"}) — Publish live is available.`,
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

/** The groups (and, per group, the pages) a fix request covers. */
export interface FixSelection {
  readonly key: string;
  /** Only these pages of the group; omitted = every page of it. */
  readonly pagePaths?: readonly string[];
}

/** The groups narrowed to a selection; unknown keys and paths drop out. */
export function selectGroups(
  groups: readonly ProblemGroup[],
  selection: readonly FixSelection[],
): ProblemGroup[] {
  const out: ProblemGroup[] = [];
  for (const sel of selection) {
    const g = groups.find((x) => x.key === sel.key);
    if (!g) continue;
    const paths = sel.pagePaths ? new Set(sel.pagePaths) : null;
    const pages = paths ? g.pages.filter((p) => paths.has(p.pagePath)) : g.pages;
    if (pages.length > 0) out.push({ ...g, pages });
  }
  return out;
}

/** The groups of a fix request, one line each with every page (bounded). */
function groupsBlock(groups: readonly ProblemGroup[]): string {
  return groups
    .slice(0, 20)
    .map((g) => `- ${groupSummaryLine(g, 12)}`)
    .concat(groups.length > 20 ? [`- … and ${groups.length - 20} more group(s)`] : [])
    .join("\n");
}

/** The standing instruction of every fix request (#727 "optimum"). */
const OPTIMUM_INSTRUCTION =
  "The target is 100 in every Lighthouse category and zero findings: a score like 90 is NOT good enough on its own. Keep fixing until the target is reached, reading the metrics in get_quality_audit (never run Lighthouse yourself). " +
  "Findings marked CAELO PLATFORM are Caelo bugs: report them with bug_report and do not change the site for them. " +
  "Only when something truly cannot be fixed (explain why), offer me ONE decision per group with accept_quality_findings (groups) — never for something you could still fix, and never as your recommendation.";

/**
 * The turn a fix click sends: every open group ("Fix with AI"), or only
 * the groups / pages the operator picked on the card. Null when the
 * selection matches no open problem (nothing to fix).
 */
export function fixPromptFor(
  audit: ChatAuditSummary,
  selection: readonly FixSelection[] | null,
): string | null {
  const groups = selection === null ? [...audit.groups] : selectGroups(audit.groups, selection);
  if (groups.length === 0) return null;
  const pageCount = new Set(groups.flatMap((g) => g.pages.map((p) => p.pagePath))).size;
  const scope =
    selection === null
      ? `Please fix the quality findings of the staged build: ${groups.length} group(s) on ${pageCount} page(s). Publish live is blocked until they are fixed or accepted.`
      : `Please fix these quality findings I picked: ${groups.length} group(s) on ${pageCount} page(s). Leave the other findings alone for now.`;
  // Promised only when the round this prompt starts can still be followed
  // by an automatic one (the round cap; spend is checked when it settles).
  const next =
    selection === null && audit.fixRound + 1 < MAX_AUTO_FIX_ROUNDS
      ? " The chat sends you the next round on its own as long as each round gets closer to the target, so fix everything you can now instead of reporting problems back to me."
      : "";
  const round = `Fix round ${audit.fixRound + 1}: call get_quality_audit for the details, fix what you can, then Stage again yourself (stage_changes) so the fixes are re-checked.${next}`;
  return `${scope}\nFindings by group:\n${groupsBlock(groups)}\n${stagedByPrompt(audit.stagedBy)}\n${round} ${OPTIMUM_INSTRUCTION}`;
}

function problemsOffer(audit: ChatAuditSummary): ChatFeedback {
  if (audit.groups.length === 0) {
    return {
      kind: "note",
      text: "Quality check: every remaining finding is accepted by an editor — Publish live is available. Accepted findings stay listed (and revocable) under Settings → Quality.",
    };
  }
  const pageCount = new Set(audit.groups.flatMap((g) => g.pages.map((p) => p.pagePath))).size;
  const summary = `Quality check found ${audit.groups.length} kind(s) of issue on ${pageCount} page(s): ${audit.groups
    .slice(0, 3)
    .map((g) => `${g.title} (${g.pages.length} page(s))`)
    .join("; ")}${audit.groups.length > 3 ? `; and ${audit.groups.length - 3} more` : ""}.`;
  const who = stagedByCard(audit.stagedBy);
  const lead = who ? `${summary} ${who}` : summary;
  const prompt = fixPromptFor(audit, null) as string;
  const groupsCopy = [...audit.groups];
  const chain = audit.fixChain;
  const progressed = chain !== null && madeProgress(chain.before, chain.now);
  if (chain && progressed && audit.fixRound >= MAX_AUTO_FIX_ROUNDS) {
    return {
      kind: "offer",
      text: `${lead} The AI's fix round went from ${describeDistance(chain.before)} to ${describeDistance(chain.now)}, but it has run ${audit.fixRound} round(s), the most one click runs on its own. Publish live stays blocked until each is fixed or accepted — let it keep trying, or decide per group below.`,
      actionLabel: "Keep fixing with AI",
      prompt,
      groups: groupsCopy,
      autoContinue: false,
    };
  }
  if (chain && progressed && chain.spentMicrocents >= AUTO_FIX_COST_CAP_MICROCENTS) {
    return {
      kind: "offer",
      text: `${lead} The AI's fix round went from ${describeDistance(chain.before)} to ${describeDistance(chain.now)}, but these rounds used ${usd(chain.spentMicrocents)} of AI spend, the most one click spends on its own (${usd(AUTO_FIX_COST_CAP_MICROCENTS)}). Publish live stays blocked until each is fixed or accepted — let it keep trying, or decide per group below.`,
      actionLabel: "Keep fixing with AI",
      prompt,
      groups: groupsCopy,
      autoContinue: false,
    };
  }
  if (chain && progressed) {
    return {
      kind: "offer",
      text: `${lead} The AI's fix round went from ${describeDistance(chain.before)} to ${describeDistance(chain.now)} — it keeps fixing on its own until the target is reached, at most ${MAX_AUTO_FIX_ROUNDS} rounds and ${usd(AUTO_FIX_COST_CAP_MICROCENTS)} of AI spend per click (Stop halts it).`,
      actionLabel: "Fix all with AI",
      prompt,
      groups: groupsCopy,
      autoContinue: true,
    };
  }
  if (chain) {
    return {
      kind: "offer",
      text: `${lead} The AI's last fix round got no closer to the target (${describeDistance(chain.before)} before, ${describeDistance(chain.now)} now), so it stopped. Publish live stays blocked until each is fixed or accepted — let it keep trying, or decide per group below.`,
      actionLabel: "Keep fixing with AI",
      prompt,
      groups: groupsCopy,
      autoContinue: false,
    };
  }
  return {
    kind: "offer",
    text: `${lead} The target is 100 and zero findings; Publish live stays blocked until each is fixed or accepted. Let the AI fix them, or decide per group below.`,
    actionLabel: "Fix all with AI",
    prompt,
    groups: groupsCopy,
    autoContinue: false,
  };
}
