// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.4 (issue #76 follow-up) — AI tool: set_site_identity.
 *
 * The AI's primary entry point for capturing site identity on a cold-
 * start install. Caelo is chat-first per CLAUDE.md §1A — there's no
 * forms-based onboarding. When the operator opens /edit and says
 * something like *"build me a homepage for an AI-first CMS called
 * Caelo"*, the AI infers siteName + sitePurpose from that prompt and
 * calls this tool BEFORE authoring modules so the identity persists
 * into every future chat's system prompt.
 *
 * The system-prompt `## Site identity` block tells the AI when to
 * call this: it surfaces an "untouched install" warning when both
 * `siteName` and `sitePurpose` are null. The AI proposes values in
 * its first turn, captures them via this tool, then proceeds to
 * theme evolution + module authoring.
 */

import { execute } from "@caelo-cms/query-api";
import { designBriefSchema } from "@caelo-cms/shared";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const setSiteIdentityToolInput = z
  .object({
    /**
     * The site's display name as it should appear in the header and
     * the AI's system-prompt context. Operator-supplied or AI-inferred
     * from the chat prompt.
     */
    siteName: z.string().min(1).max(200).nullable().optional(),
    /**
     * One or two sentences describing what the site is for and who
     * it's for. Carried into the `## Site identity` block so every
     * future chat has the brand context.
     */
    sitePurpose: z.string().min(1).max(2000).nullable().optional(),
    /**
     * issue #163 — structured Design Brief from the Genesis discovery
     * dialog (audience, moodWords, tone, industry, differentiators,
     * imageryDirection, avoid). Drives the parallel draft subagents.
     */
    designBrief: designBriefSchema.nullable().optional(),
  })
  .strict();
type SetSiteIdentityToolInput = z.infer<typeof setSiteIdentityToolInput>;

export const setSiteIdentityTool: ToolDefinitionWithHandler<SetSiteIdentityToolInput> = {
  name: "set_site_identity",
  description:
    "Record the site's identity (display name + purpose) so future chats inherit the brand context. " +
    "On a fresh install where the `## Site identity` block shows '(untouched)', call this in your FIRST " +
    "turn — infer `siteName` and `sitePurpose` from the operator's chat prompt and capture them BEFORE " +
    "authoring any modules. Example: operator says 'build me a homepage for an AI-first CMS called Caelo, " +
    "trustworthy and developer-focused' → call `set_site_identity({siteName: 'Caelo', sitePurpose: 'An " +
    "AI-first CMS for developers — trustworthy, branched edits, plugin sandbox'})`. If the operator " +
    "hasn't given you enough to infer (e.g. they ask 'add a contact form' on an unconfigured install), " +
    "ASK them for the missing essentials before guessing. " +
    "Pass `null` to clear a field. " +
    "During Site Genesis, ALSO pass `designBrief` ({audience, moodWords, tone, industry, differentiators, imageryDirection, avoid}) — it feeds the parallel draft subagents and every future design decision.",
  schema: setSiteIdentityToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      siteName: { type: ["string", "null"], minLength: 1, maxLength: 200 },
      sitePurpose: { type: ["string", "null"], minLength: 1, maxLength: 2000 },
      designBrief: {
        type: ["object", "null"],
        additionalProperties: false,
        properties: {
          audience: { type: "string", minLength: 1, maxLength: 500 },
          moodWords: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 40 },
            maxItems: 12,
          },
          tone: { type: "string", minLength: 1, maxLength: 300 },
          industry: { type: "string", minLength: 1, maxLength: 200 },
          differentiators: { type: "string", minLength: 1, maxLength: 1000 },
          imageryDirection: { type: "string", minLength: 1, maxLength: 500 },
          avoid: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    if (
      input.siteName === undefined &&
      input.sitePurpose === undefined &&
      input.designBrief === undefined
    ) {
      return {
        ok: false,
        content:
          "set_site_identity needs at least one of `siteName`, `sitePurpose`, or `designBrief`.",
      };
    }
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "site_defaults.set_identity",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `site_defaults.set_identity failed: ${describeError(r.error)}` };
    }
    const parts: string[] = [];
    if (input.siteName !== undefined) {
      parts.push(
        input.siteName === null ? "cleared site name" : `set siteName='${input.siteName}'`,
      );
    }
    if (input.sitePurpose !== undefined) {
      parts.push(input.sitePurpose === null ? "cleared site purpose" : "set sitePurpose");
    }
    return { ok: true, content: parts.join(", ") };
  },
};
