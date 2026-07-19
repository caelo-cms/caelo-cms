// SPDX-License-Identifier: MPL-2.0

/**
 * Skills context blocks for the chat-runner.
 *
 * Skills use PROGRESSIVE DISCLOSURE (the Anthropic Agent Skills / Claude Code
 * shape). `buildSkillsContext` emits a compact, STATIC `## Skills` index —
 * every active skill's `slug + description` — that lives in the cached system
 * prefix. The model reads the index and, when a task matches a skill, calls the
 * `load_skill` tool; that tool's RESULT (the full body) lands in the append-only
 * message history and stays for the rest of the chat. So the dynamic skill
 * bodies never enter the system prompt (which would bust the prompt cache on
 * every engagement) — only the tiny static index does, and each body is
 * injected exactly once, via history (CLAUDE.md §2).
 *
 * `buildSkillsContext` produces the static index + the tool-preload hints for
 * skills already loaded this chat.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ChatEngagement, ExecutionContext } from "@caelo-cms/shared";

interface ActiveSkillRow {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  body: string;
  allowlistedTools: string[];
  /**
   * Auto-engagement hints. No longer drive SELECTION (the model self-selects
   * from descriptions), but they shape HOW prominently a skill is presented in
   * the static index: `alwaysOn` skills get an "always applies" callout (load
   * before the relevant work), `chipTrigger` skills a "when chips are attached"
   * callout — so structural-trigger skills (brand voice, scoped edit) are
   * impossible to miss even though their bodies still load on demand.
   */
  hints: { alwaysOn?: boolean; chipTrigger?: boolean };
}

export interface SkillsContext {
  /**
   * The STATIC `## Skills` index (one `slug: description` line per active
   * skill). Goes in the cached system prefix — it changes only when the Owner
   * activates/archives a skill, not per turn.
   */
  skillsIndexBlock: string | undefined;
  /**
   * Tool-preload hints: the union of the allowlisted tools of skills already
   * loaded this chat, so their tools stay loaded without a tool-search
   * round-trip on later turns. Null when nothing is loaded.
   */
  allowedToolNames: Set<string> | null;
  /** Loaded skills (for the tool-catalogue diagnostic log line). */
  engagedSkills: ChatEngagement[];
}

/**
 * Parse the slugs the model has already loaded this chat, from prior
 * `load_skill` tool calls in the persisted history. Each successful load put
 * the skill body into the message history (the tool result); this recovers the
 * set so `buildSkillsContext` can keep those skills' tools preloaded and feed
 * the subagent-hint heuristic. Defensive against jsonb-string args.
 */
export function extractLoadedSkillSlugs(messages: readonly { toolCalls?: unknown }[]): string[] {
  const slugs = new Set<string>();
  for (const m of messages) {
    const calls = m.toolCalls;
    if (!Array.isArray(calls)) continue;
    for (const c of calls) {
      if (!c || typeof c !== "object") continue;
      if ((c as { name?: unknown }).name !== "load_skill") continue;
      let argsRaw = (c as { arguments?: unknown }).arguments;
      if (typeof argsRaw === "string") {
        try {
          argsRaw = JSON.parse(argsRaw);
        } catch {
          continue;
        }
      }
      const slug =
        argsRaw && typeof argsRaw === "object" ? (argsRaw as { slug?: unknown }).slug : undefined;
      if (typeof slug === "string" && slug.length > 0) slugs.add(slug);
    }
  }
  return [...slugs];
}

/**
 * Build the static skills index + the preload hints for skills loaded so far.
 *
 * @param args.loadedSkillSlugs slugs the model already loaded this chat
 *   (parsed from prior `load_skill` tool calls in the history). Drives the
 *   tool preload + the subagent-hint body text.
 */
export async function buildSkillsContext(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  humanCtx: ExecutionContext,
  args: { loadedSkillSlugs: readonly string[] },
): Promise<SkillsContext> {
  const empty: SkillsContext = {
    skillsIndexBlock: undefined,
    allowedToolNames: null,
    engagedSkills: [],
  };
  const skillsListResult = await execute(registry, adapter, humanCtx, "skills.list", {
    status: "active",
  });
  if (!skillsListResult.ok) return empty;
  const activeSkills = (skillsListResult.value as { skills: ActiveSkillRow[] }).skills;
  if (activeSkills.length === 0) return empty;

  // The index is the ONLY skill content in the system prompt (never a body).
  // Sort by slug so the block is byte-stable across turns (a stable cached
  // prefix); it changes only on Owner activation/archival, not per turn.
  // Structural-trigger skills (alwaysOn / chipTrigger) get their own callout so
  // the model reliably loads them at the right moment even though the guidance
  // itself is fetched on demand via load_skill.
  const sorted = [...activeSkills].sort((a, b) => a.slug.localeCompare(b.slug));
  const line = (s: ActiveSkillRow): string => `- ${s.slug}: ${s.description}`;
  const alwaysOn = sorted.filter((s) => s.hints.alwaysOn === true);
  const chip = sorted.filter((s) => s.hints.alwaysOn !== true && s.hints.chipTrigger === true);
  const regular = sorted.filter((s) => s.hints.alwaysOn !== true && s.hints.chipTrigger !== true);
  const parts: string[] = [
    "# Skills",
    "Skills are packaged instructions for specific tasks. Load one with load_skill({slug}); its guidance enters this conversation and stays for the rest of the chat, so load each skill only once (do not reload one already loaded above).",
  ];
  if (alwaysOn.length > 0) {
    parts.push(
      "ALWAYS APPLIES — load these before the relevant work (e.g. before writing or editing ANY visitor-facing copy) and follow them:",
      ...alwaysOn.map(line),
    );
  }
  if (chip.length > 0) {
    parts.push(
      "When the current message has attached element references (chips), load first:",
      ...chip.map(line),
    );
  }
  if (regular.length > 0) {
    parts.push("Load when a task matches:", ...regular.map(line));
  }
  const skillsIndexBlock = parts.join("\n");

  const loadedSet = new Set(args.loadedSkillSlugs);
  const loaded = activeSkills.filter((s) => loadedSet.has(s.slug));
  const engagedSkills: ChatEngagement[] = loaded.map((s) => ({
    skillId: s.id,
    slug: s.slug,
    displayName: s.displayName,
    source: "auto",
    rationale: "loaded",
  }));
  const preload = new Set<string>();
  for (const s of loaded) for (const t of s.allowlistedTools) preload.add(t);

  return {
    skillsIndexBlock,
    allowedToolNames: preload.size > 0 ? preload : null,
    engagedSkills,
  };
}
