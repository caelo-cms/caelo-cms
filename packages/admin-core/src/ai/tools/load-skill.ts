// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: load_skill — the activation step of progressive-disclosure skills
 * (the state-of-the-art shape Anthropic Agent Skills / Claude Code use).
 *
 * The `## Skills` system-prompt block lists every active skill's slug +
 * description (cheap, static, cached). When a task matches one, the model
 * calls `load_skill({slug})` to pull that skill's FULL instructions into the
 * conversation. The instructions come back as this tool's result, so they land
 * in the append-only message history and stay there for the rest of the chat
 * (CLAUDE.md §2 — no volatile system-prompt block to bust the cache; the
 * static skill INDEX is cached, the dynamic bodies flow through history). Each
 * skill therefore loads at most once — on later turns its body is already in
 * context and the model does not re-load it.
 *
 * Unknown / inactive slug → a structured error naming the active slugs, so the
 * model can self-correct without a human round-trip (§11 AI-actionable errors).
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
    "Load a skill's full instructions into this conversation. Call this the MOMENT a task matches a skill listed in the `## Skills` block — BEFORE doing the work — then follow the instructions it returns. " +
    "The instructions become part of the conversation and stay for the rest of the chat, so load each skill only ONCE (if it's already loaded above, don't reload it). " +
    "Input: {slug} — the exact slug from the `## Skills` block. An unknown or inactive slug returns the list of valid slugs.",
  schema: loadSkillToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slug"],
    properties: {
      slug: { type: "string", pattern: "^[a-z0-9-]+$", minLength: 1, maxLength: 120 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "skills.get", {
      slug: input.slug,
    });
    if (!got.ok) return { ok: false, content: `skills.get failed: ${describeError(got.error)}` };
    const skill = (got.value as { skill: SkillRow | null }).skill;
    if (!skill || skill.status !== "active") {
      // Name the active slugs so the model retries with a real one.
      const list = await execute(toolCtx.registry, toolCtx.adapter, ctx, "skills.list", {
        status: "active",
      });
      const active = list.ok
        ? (list.value as { skills: { slug: string }[] }).skills.map((s) => s.slug)
        : [];
      return {
        ok: false,
        content:
          `No active skill with slug "${input.slug}". ` +
          (active.length > 0
            ? `Active skills you can load: ${active.join(", ")}.`
            : "There are no active skills to load."),
      };
    }
    const toolsNote =
      skill.allowlistedTools.length > 0
        ? `\n\nTools this skill uses (now available to you): ${skill.allowlistedTools.join(", ")}.`
        : "";
    return {
      ok: true,
      content:
        `Loaded skill "${skill.slug}" — ${skill.displayName}. Follow these instructions for the rest of this chat:\n\n` +
        skill.body +
        toolsNote,
    };
  },
};
