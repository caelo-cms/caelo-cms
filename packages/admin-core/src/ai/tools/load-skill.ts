// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: load_skill — the activation step of progressive-disclosure skills
 * (the state-of-the-art shape Anthropic Agent Skills / Claude Code use).
 *
 * The `## Skills` system-prompt block lists every active skill's slug +
 * description (cheap, static, cached). When a task matches one or more, the
 * model calls `load_skill({slugs})` to pull their FULL instructions into the
 * conversation. The instructions come back as this tool's result, so they land
 * in the append-only message history and stay there for the rest of the chat
 * (CLAUDE.md §2 — no volatile system-prompt block to bust the cache; the
 * static skill INDEX is cached, the dynamic bodies flow through history). Each
 * skill therefore loads at most once — on later turns its body is already in
 * context and the model does not re-load it.
 *
 * Takes a LIST because a load is a routine operation and §11 says routine
 * operations ship in bulk form, with n=1 as the smallest case rather than a
 * separate singular tool. Observed live turns loaded two to four skills, one
 * provider round-trip each, every round-trip producing a single tool call.
 * Skills whose relevance only becomes clear later still cost a second call —
 * the bulk form removes the round-trips the model could have avoided, not the
 * ones it could not have foreseen.
 *
 * Unknown / inactive slugs → named back with the list of active ones, so the
 * model can self-correct without a human round-trip (§11 AI-actionable
 * errors). Slugs that DID resolve are still returned: a partial load is
 * progress, and failing the batch over one bad slug would waste the rest.
 */

import { execute } from "@caelo-cms/query-api";
import { loadSkillToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface SkillRow {
  slug: string;
  displayName: string;
  body: string;
  allowlistedTools: string[];
  status: "awaiting_activation" | "active" | "archived";
}

export const loadSkillTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").LoadSkillToolInput
> = {
  name: "load_skill",
  description:
    "Load skills' full instructions into this conversation. Call this the MOMENT a task matches one or more skills listed in the `## Skills` block — BEFORE doing the work — then follow the instructions it returns. " +
    "The instructions become part of the conversation and stay for the rest of the chat, so load each skill only ONCE (if it's already loaded above, don't reload it). " +
    "Input: {slugs} — exact slugs from the `## Skills` block. Pass EVERY skill you already know you need in ONE call; a second call is only for a skill whose relevance you discover later. Unknown or inactive slugs are named back to you along with the list of valid ones.",
  schema: loadSkillToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slugs"],
    properties: {
      slugs: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: { type: "string", pattern: "^[a-z0-9-]+$", minLength: 1, maxLength: 120 },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    // Same slug twice in one call is a model slip, not a reason to inject the
    // body twice — the whole point of the tool is that a body lands once.
    const wanted = [...new Set(input.slugs)];
    const loaded: string[] = [];
    const missing: string[] = [];
    const sections: string[] = [];

    for (const slug of wanted) {
      const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "skills.get", { slug });
      if (!got.ok) return { ok: false, content: `skills.get failed: ${describeError(got.error)}` };
      const skill = (got.value as { skill: SkillRow | null }).skill;
      if (skill?.status !== "active") {
        missing.push(slug);
        continue;
      }
      loaded.push(skill.slug);
      const toolsNote =
        skill.allowlistedTools.length > 0
          ? `\n\nTools this skill uses (now available to you): ${skill.allowlistedTools.join(", ")}.`
          : "";
      sections.push(
        `Loaded skill "${skill.slug}" — ${skill.displayName}. Follow these instructions for the rest of this chat:\n\n${skill.body}${toolsNote}`,
      );
    }

    // Name the active slugs so the model can self-correct without a human
    // round-trip (§11). Fetched once, not once per bad slug.
    let missingNote = "";
    if (missing.length > 0) {
      const list = await execute(toolCtx.registry, toolCtx.adapter, ctx, "skills.list", {
        status: "active",
      });
      const active = list.ok
        ? (list.value as { skills: { slug: string }[] }).skills.map((s) => s.slug)
        : [];
      missingNote =
        `No active skill with slug ${missing.map((s) => `"${s}"`).join(", ")}. ` +
        (active.length > 0
          ? `Active skills you can load: ${active.join(", ")}.`
          : "There are no active skills to load.");
    }

    // A partial load is still progress: returning the bodies that resolved
    // beats failing the whole call over one bad slug, and the note tells the
    // model exactly what to retry.
    if (loaded.length === 0) return { ok: false, content: missingNote };
    return {
      ok: true,
      content: missingNote
        ? `${sections.join("\n\n---\n\n")}\n\n${missingNote}`
        : sections.join("\n\n---\n\n"),
    };
  },
};
