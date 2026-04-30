// SPDX-License-Identifier: MPL-2.0

/**
 * P10A — skill auto-matcher (pure function).
 *
 * Scores site-active skills against the current chat turn's user
 * message + element-reference chips. Top-K matches go into
 * `auto`-source engagements; pinned defaults + manual overrides
 * compose with the matcher output in the chat-runner.
 *
 * Scoring is intentionally simple — keyword + chip-trigger + always-on
 * — to keep this layer LLM-free. The matcher runs every turn; an
 * LLM-based matcher would double provider cost without obvious gain.
 */

import { z } from "zod";

export const skillAutoEngagementHints = z
  .object({
    /** Lowercase substrings that boost the score when present in the user message. */
    keywords: z.array(z.string().min(1).max(80)).default([]),
    /** When true, engage automatically whenever element-ref chips are attached. */
    chipTrigger: z.boolean().default(false),
    /** When true, always engage on every call (e.g. brand-voice-guard). */
    alwaysOn: z.boolean().default(false),
  })
  .strict();
export type SkillAutoEngagementHints = z.infer<typeof skillAutoEngagementHints>;

export interface CandidateSkill {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly hints: SkillAutoEngagementHints;
}

export interface MatcherInput {
  readonly userMessage: string;
  /** Element-reference chips attached to this turn (P5 click-to-chat). */
  readonly chipCount: number;
  readonly skills: readonly CandidateSkill[];
  /** Top-K cap. Defaults to 5 — engaging more than 5 skills bloats the system prompt. */
  readonly topK?: number;
}

export interface SkillMatch {
  readonly skillId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly score: number;
  readonly rationale: string;
}

/**
 * Score every candidate skill against the turn context. Returns the
 * top-K matches sorted by score (descending). `alwaysOn` skills always
 * score at least 1; `chipTrigger` skills score 100 when chips present;
 * keywords add 1 per matching keyword (case-insensitive substring).
 *
 * Skills with score 0 are dropped — they never engage automatically.
 */
export function matchSkills(input: MatcherInput): SkillMatch[] {
  const topK = input.topK ?? 5;
  const lowered = input.userMessage.toLowerCase();
  const matches: SkillMatch[] = [];
  for (const s of input.skills) {
    let score = 0;
    const reasons: string[] = [];
    if (s.hints.alwaysOn) {
      score += 1;
      reasons.push("always-on");
    }
    if (s.hints.chipTrigger && input.chipCount > 0) {
      score += 100;
      reasons.push(`element chips (${input.chipCount})`);
    }
    const matchedKeywords: string[] = [];
    for (const k of s.hints.keywords) {
      const needle = k.toLowerCase();
      if (needle.length > 0 && lowered.includes(needle)) {
        matchedKeywords.push(k);
      }
    }
    if (matchedKeywords.length > 0) {
      score += matchedKeywords.length;
      const sample = matchedKeywords.slice(0, 3).join(", ");
      reasons.push(
        matchedKeywords.length > 3
          ? `keywords: ${sample}, +${matchedKeywords.length - 3}`
          : `keywords: ${sample}`,
      );
    }
    if (score > 0) {
      matches.push({
        skillId: s.id,
        slug: s.slug,
        displayName: s.displayName,
        score,
        rationale: reasons.join("; "),
      });
    }
  }
  matches.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
  return matches.slice(0, topK);
}

export type EngagementSource = "auto" | "manual" | "pinned";

export interface ChatEngagement {
  readonly skillId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly source: EngagementSource;
  readonly rationale: string;
}

/**
 * Resolve the final per-call engagement set. Composition rules:
 *   - Manual ENGAGE overrides matcher (always engaged).
 *   - Manual DISENGAGE overrides matcher + pinned (never engaged).
 *   - Pinned defaults engage unless manually disengaged.
 *   - Auto matches engage unless manually disengaged.
 *
 * Returns the final set tagged with the source so the UI panel can
 * render badges + the user can see which decisions came from where.
 */
export interface ResolveEngagementsInput {
  readonly autoMatches: readonly SkillMatch[];
  /**
   * Manual overrides per chat. NULL = no overrides yet (auto + pinned only).
   * Empty array = explicit "user disengaged everything" intent.
   * Non-empty = list of explicit engages + disengages.
   */
  readonly manualOverrides: ReadonlyArray<{
    skillId: string;
    slug: string;
    displayName: string;
    intent: "engage" | "disengage";
  }> | null;
  readonly pinnedSkills: ReadonlyArray<{
    skillId: string;
    slug: string;
    displayName: string;
  }>;
}

export function resolveEngagements(input: ResolveEngagementsInput): ChatEngagement[] {
  const disengaged = new Set<string>();
  const engagedManual = new Map<string, ChatEngagement>();
  if (input.manualOverrides) {
    for (const m of input.manualOverrides) {
      if (m.intent === "disengage") {
        disengaged.add(m.skillId);
      } else {
        engagedManual.set(m.skillId, {
          skillId: m.skillId,
          slug: m.slug,
          displayName: m.displayName,
          source: "manual",
          rationale: "manually engaged",
        });
      }
    }
  }
  const out = new Map<string, ChatEngagement>();
  // Pinned defaults first (lowest priority among engaged).
  for (const p of input.pinnedSkills) {
    if (disengaged.has(p.skillId)) continue;
    out.set(p.skillId, {
      skillId: p.skillId,
      slug: p.slug,
      displayName: p.displayName,
      source: "pinned",
      rationale: "pinned default",
    });
  }
  // Auto matches — overwrite pinned label only if not already in out.
  for (const a of input.autoMatches) {
    if (disengaged.has(a.skillId)) continue;
    if (out.has(a.skillId)) continue;
    out.set(a.skillId, {
      skillId: a.skillId,
      slug: a.slug,
      displayName: a.displayName,
      source: "auto",
      rationale: a.rationale,
    });
  }
  // Manual engages always win — always overwrite.
  for (const m of engagedManual.values()) {
    out.set(m.skillId, m);
  }
  return [...out.values()];
}
