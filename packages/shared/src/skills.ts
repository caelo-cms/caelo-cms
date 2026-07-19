// SPDX-License-Identifier: MPL-2.0

/**
 * Skill metadata shapes shared across the Query API + chat-runner.
 *
 * Skills use PROGRESSIVE DISCLOSURE (the Anthropic Agent Skills shape): a
 * static `## Skills` index (slug + description) sits in the cached system
 * prompt, and the model pulls a skill's full body into the conversation on
 * demand via the `load_skill` tool (its body then lives in the append-only
 * message history for the rest of the chat).
 *
 * `skillAutoEngagementHints` no longer drives SELECTION — the model
 * self-selects from the descriptions. The hints now only shape how prominently
 * a skill is presented in the index: `alwaysOn` skills get an "always applies"
 * callout, `chipTrigger` skills a "when element chips are attached" callout.
 * (The old keyword/chip/always-on MATCHER + engagement resolver were removed
 * once progressive disclosure replaced them.)
 */

import { z } from "zod";

export const skillAutoEngagementHints = z
  .object({
    /**
     * Lowercase substrings that once boosted the auto-matcher. The matcher is
     * gone (progressive disclosure); retained in the schema so seeded rows that
     * still carry keywords parse under `.strict()`. No runtime effect today.
     */
    keywords: z.array(z.string().min(1).max(80)).default([]),
    /** Listed under the index's "when element chips are attached" callout. */
    chipTrigger: z.boolean().default(false),
    /** Listed under the index's "always applies" callout (e.g. brand-voice-guard). */
    alwaysOn: z.boolean().default(false),
  })
  .strict();
export type SkillAutoEngagementHints = z.infer<typeof skillAutoEngagementHints>;

/** How a loaded skill came to be engaged this chat. */
export type EngagementSource = "auto" | "manual" | "pinned";

/** A skill the model has loaded (via load_skill) in the current chat. */
export interface ChatEngagement {
  readonly skillId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly source: EngagementSource;
  readonly rationale: string;
}
