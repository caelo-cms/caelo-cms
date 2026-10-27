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
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface SkillRow {
  slug: string;
  displayName: string;
  body: string;
  allowlistedTools: string[];
  status: "awaiting_activation" | "active" | "archived";
}

/**
 * The closing note naming a skill's tools. It must not claim more than is
 * true: loading a skill does NOT load its tools into the running turn — the
 * tool list is the same on every turn of a chat (a changed one would make
 * the provider re-cache the whole history), and only the core set ships in
 * full; the rest sit behind tool search. The note used to say "now available to you" for all of them,
 * and the model then called a deferred tool (bootstrap_site_scaffold) it
 * could not emit — what came out instead was a `bug_report` with the
 * literal values "placeholder" (two e2e-livedit runs, 2026-10), after which
 * the model searched the tool and called it properly.
 *
 * @param preloaded - this turn's always-loaded tool names; undefined on
 *   surfaces that list every tool with its schema (Power-MCP).
 */
export function skillToolsNote(
  tools: readonly string[],
  preloaded: ReadonlySet<string> | undefined,
): string {
  if (tools.length === 0) return "";
  if (preloaded === undefined) return `\n\nTools this skill uses: ${tools.join(", ")}.`;
  const loaded = tools.filter((t) => preloaded.has(t));
  const deferred = tools.filter((t) => !preloaded.has(t));
  const parts = [`\n\nTools this skill uses: ${tools.join(", ")}.`];
  if (loaded.length > 0) parts.push(` Already in your tool list: ${loaded.join(", ")}.`);
  if (deferred.length > 0) {
    parts.push(
      ` Possibly NOT loaded yet: ${deferred.join(", ")} — loading this skill does not load them. ` +
        "Before calling one that is not in your tool list, load it with the tool-search tool (search its exact name); never call a different tool in its place.",
    );
  }
  return parts.join("");
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

    for (const slug of wanted) {
      const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "skills.get", { slug });
      if (!got.ok) return { ok: false, content: `skills.get failed: ${describeError(got.error)}` };
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
      const toolsNote = skillToolsNote(skill.allowlistedTools, toolCtx.preloadedToolNames);
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
    const notes = [...notRunning, ...(missingNote ? [missingNote] : [])].join("\n");
    if (loaded.length === 0) return { ok: false, content: notes };
    return {
      ok: true,
      content: notes ? `${sections.join("\n\n---\n\n")}\n\n${notes}` : sections.join("\n\n---\n\n"),
    };
  },
};
