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
import { LOAD_SKILL_MAX_SLUGS, loadSkillToolInput } from "@caelo-cms/shared";
import { describeError, toolError } from "./_describe-error.js";
import type { ToolContext, ToolDefinitionWithHandler } from "./dispatch.js";

interface SkillRow {
  slug: string;
  displayName: string;
  body: string;
  allowlistedTools: string[];
  status: "awaiting_activation" | "active" | "archived";
}

/** What load_skill tells the model about a skill's tools, and what it loads. */
export interface SkillToolsLoad {
  /** The closing note appended to the skill body ("" for a skill without tools). */
  readonly note: string;
  /** The skill's deferred tools, loaded into the conversation with this result. */
  readonly references: readonly string[];
}

/**
 * The tools a skill uses, loaded so the model can call every one of them
 * without a search (#991).
 *
 * Most of a skill's tools sit behind the provider's tool search: only the
 * core set ships in full, and the tool list is the same on every step of a
 * chat (a changed one would make the provider re-cache the whole history).
 * Loading a skill used to load none of them. The model then either paid a
 * search pass per tool — a whole extra model pass over the context, 50–190k
 * input tokens per search in the homepage scenario (#809) — or, when it
 * skipped the search, called a loaded tool in place of the one it meant:
 * `bug_report` with the literal values "placeholder", or
 * `set_content_instance_values_many` with a page id right before it searched
 * and called `set_page_seo` (e2e-livedit 2026-10). The result therefore
 * carries the skill's deferred tools as `tool_reference` blocks, which the
 * provider expands into full definitions in place, exactly as its own
 * search does, and the note says they are callable.
 *
 * @param turnTools - this turn's catalogue and the tools it defers;
 *   undefined on surfaces that list every tool with its schema (Power-MCP).
 */
export function skillToolsLoad(
  tools: readonly string[],
  turnTools: ToolContext["turnTools"],
): SkillToolsLoad {
  if (tools.length === 0) return { note: "", references: [] };
  if (turnTools === undefined) {
    return { note: `\n\nTools this skill uses: ${tools.join(", ")}.`, references: [] };
  }
  const references = tools.filter((t) => turnTools.deferred.has(t));
  const missing = tools.filter((t) => !turnTools.names.has(t));
  const parts = [`\n\nTools this skill uses: ${tools.join(", ")}.`];
  if (references.length > 0) {
    parts.push(` Loaded with this skill, callable from your next step: ${references.join(", ")}.`);
  }
  if (missing.length > 0) {
    parts.push(
      ` Not available in this chat: ${missing.join(", ")} — skip the steps that need them, or tell the operator; never call a different tool in their place.`,
    );
  }
  return { note: parts.join(""), references };
}

export const loadSkillTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").LoadSkillToolInput
> = {
  name: "load_skill",
  description:
    "Load skills' full instructions into this conversation. Call the MOMENT a task matches skills in the `## Skills` block, BEFORE the work, then follow them. " +
    "They persist for the whole chat -> load each skill ONCE (never reload one already loaded). Pass EVERY skill you know you need in ONE call; a second call only for one found relevant later.",
  schema: loadSkillToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slugs"],
    properties: {
      slugs: {
        type: "array",
        minItems: 1,
        maxItems: LOAD_SKILL_MAX_SLUGS,
        items: { type: "string", pattern: "^[a-z0-9-]+$", minLength: 1, maxLength: 120 },
        description:
          "Exact slugs from `## Skills`. Unknown/inactive slugs are named back with the valid list.",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    // Same slug twice in one call is a model slip, not a reason to inject the
    // body twice — the whole point of the tool is that a body lands once.
    const wanted = [...new Set(input.slugs)];
    const loaded: string[] = [];
    const missing: string[] = [];
    const notRunning: string[] = [];
    const sections: string[] = [];
    // One reference per tool, however many of the loaded skills use it.
    const references = new Set<string>();

    for (const slug of wanted) {
      const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "skills.get", { slug });
      if (!got.ok) return toolError(got.error, `skills.get failed: ${describeError(got.error)}`);
      const value = got.value as {
        skill: SkillRow | null;
        notRunningHere: { pluginSlug: string; reason: string } | null;
      };
      // #1008 — its plugin failed to load on this server: its tools are
      // absent here, so its instructions would send the AI to tools that
      // do not exist. Say why and what to do instead of "unknown skill".
      if (value.notRunningHere) {
        notRunning.push(
          `Skill "${slug}" is not available: its plugin "${value.notRunningHere.pluginSlug}" failed to load on this server (${value.notRunningHere.reason}). Do not follow it; tell the operator — /settings/plugins shows the problem and can reload the plugin.`,
        );
        continue;
      }
      const skill = value.skill;
      if (skill?.status !== "active") {
        missing.push(slug);
        continue;
      }
      loaded.push(skill.slug);
      const tools = skillToolsLoad(skill.allowlistedTools, toolCtx.turnTools);
      for (const name of tools.references) references.add(name);
      sections.push(
        `Loaded skill "${skill.slug}" — ${skill.displayName}. Follow these instructions for the rest of this chat:\n\n${skill.body}${tools.note}`,
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
    const notes = [...notRunning, ...(missingNote ? [missingNote] : [])].join("\n");
    if (loaded.length === 0) return { ok: false, content: notes };
    return {
      ok: true,
      content: notes ? `${sections.join("\n\n---\n\n")}\n\n${notes}` : sections.join("\n\n---\n\n"),
      ...(references.size > 0 ? { toolReferences: [...references] } : {}),
    };
  },
};
