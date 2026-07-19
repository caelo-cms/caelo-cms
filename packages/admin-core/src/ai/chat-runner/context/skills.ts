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
 * `buildSkillsContext` runs BEFORE the tool catalogue is built (it computes the
 * tool-preload hints for skills already loaded this chat). `buildPostCatalogueBlocks`
 * renders the subagents / plugins / plugin-promptContext blocks, which depend on
 * the already-filtered catalogue and so run AFTER it.
 */

import { pluginPromptContextRegistry } from "@caelo-cms/plugin-host";
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
   * Concatenated bodies of the skills already LOADED this chat. NOT put in the
   * system prompt — used ONLY by the subagent-hint heuristic in
   * `buildPostCatalogueBlocks` (a loaded reviewer skill's body mentions
   * spawn_subagent). The bodies themselves live in the message history via the
   * load_skill tool results.
   */
  loadedSkillsBodyText: string | undefined;
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
    loadedSkillsBodyText: undefined,
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
  const loadedSkillsBodyText = loaded.length > 0 ? loaded.map((s) => s.body).join("\n\n") : undefined;

  return {
    skillsIndexBlock,
    loadedSkillsBodyText,
    allowedToolNames: preload.size > 0 ? preload : null,
    engagedSkills,
  };
}

export interface PostCatalogueBlocks {
  subagentsBlock: string | undefined;
  pluginsBlock: string | undefined;
  pluginContextBlock: string | undefined;
}

/**
 * Renders the blocks that depend on the already-filtered tool catalogue:
 * the subagents hint (only when spawn tools survived this turn's filtering),
 * the AI's own pending/rejected plugin submissions, and the active Tier-1
 * plugin promptContext slices.
 */
export async function buildPostCatalogueBlocks(args: {
  registry: OperationRegistry;
  adapter: DatabaseAdapter;
  aiCtx: ExecutionContext;
  filteredTools: { name: string }[];
  excluded: ReadonlySet<string> | undefined;
  userMessage: string;
  /**
   * Concatenated bodies of skills loaded this chat (from `SkillsContext`).
   * Only used to decide whether to surface the subagents hint (a loaded
   * reviewer skill's body mentions spawn_subagent) — never emitted verbatim.
   */
  loadedSkillsBodyText: string | undefined;
}): Promise<PostCatalogueBlocks> {
  const { registry, adapter, aiCtx, filteredTools, excluded, userMessage, loadedSkillsBodyText } =
    args;

  // P10.5 #5 — subagents hint chunk. Emitted when (a) spawn tools are
  // visible in this turn's catalogue (so we never tell the AI to use
  // a tool it can't see — subagents themselves don't get the hint
  // because their own catalogue strips spawn_subagent) AND (b) the
  // user's message contains parallel-work cues OR a loaded skill
  // body mentions spawn_subagent. Pure text guidance; the AI decides
  // whether to act.
  let subagentsBlock: string | undefined;
  const spawnVisible =
    !excluded?.has("spawn_subagent") &&
    !excluded?.has("spawn_subagents") &&
    filteredTools.some((t) => t.name === "spawn_subagent" || t.name === "spawn_subagents");
  if (spawnVisible) {
    const lowered = userMessage.toLowerCase();
    const cuewords = [
      "audit",
      "review",
      "in parallel",
      "fan out",
      "qa",
      "categorize",
      "categorise",
      "restructure",
      "draft an article",
      "write an article",
    ];
    const matched = cuewords.some((w) => lowered.includes(w));
    const skillMentionsSubagents = loadedSkillsBodyText?.toLowerCase().includes("spawn_subagent");
    if (matched || skillMentionsSubagents) {
      subagentsBlock = [
        "# Subagents",
        "Subagents BUILD in parallel — they are a throughput tool to get independent work done faster, NOT a way to think, reason, or review in parallel. Reach for them only when you have SEVERAL pieces of work that don't depend on each other (e.g. rebuild 5 page clusters during a migration, or build 3 unrelated modules at once). YOU do the planning: decompose the work into concrete, fully-specified build briefs, then dispatch them together via `spawn_subagents`.",
        "Each child starts with a FRESH context and knows nothing about this chat, so every brief must carry what it needs to build its piece on its own: the exact structure, the content/copy, the ids, and the decisions you already made. The children build in parallel and return; you assemble the results.",
        "`spawn_subagent` (single) is for ONE bounded, multi-step build task that deserves its own isolated context (e.g. rebuild one page cluster). `spawn_subagents` (plural) runs a batch of such tasks in parallel.",
        "DO NOT spawn a subagent to do your own reasoning, to review your own work, or for anything you can finish in one or two tool calls. A single module, a footer/header/nav, one edit, a quick lookup → call the tool directly. A subagent for a single edit only adds latency and cost.",
        "Each subagent returns its built result (or, for an explicitly-scoped review task, a verdict). Ingest the results, then decide your next move.",
      ].join("\n");
    }
  }

  // P11 opt 4 — surface AI's own pending + rejected plugin submissions
  // so it doesn't re-propose what's already in the queue and reads
  // the Owner's rejection reason before resubmitting. Renders only
  // when at least one pending/rejected row exists.
  let pluginsBlock: string | undefined;
  try {
    const pendingResult = await execute(registry, adapter, aiCtx, "plugins.list_pending", {
      submittedBy: aiCtx.actorId,
    });
    if (pendingResult.ok) {
      const rows = (
        pendingResult.value as {
          plugins: Array<{
            slug: string;
            version: string;
            status: string;
            validationErrorCount: number;
            rejectionReason: string | null;
          }>;
        }
      ).plugins;
      if (rows.length > 0) {
        const lines = rows.map((p) => {
          if (p.status === "rejected") {
            return `- ${p.slug} v${p.version} — REJECTED${p.rejectionReason ? ` (reason: ${p.rejectionReason})` : ""}. Read the reason, revise, and submit a new version.`;
          }
          if (p.status === "draft") {
            return `- ${p.slug} v${p.version} — validation failed (${p.validationErrorCount} error${p.validationErrorCount === 1 ? "" : "s"}). Fix per the structured hints and resubmit.`;
          }
          return `- ${p.slug} v${p.version} — awaiting Owner approval at /security/plugins. DO NOT re-submit.`;
        });
        pluginsBlock = [
          "# Your pending plugin submissions",
          "These plugins you previously submitted are still in the queue. Do NOT re-submit duplicates; read the status before issuing a new submit_plugin call.",
          ...lines,
        ].join("\n");
      }
    }
  } catch {
    // Best-effort context block; never block the turn on a context-fetch failure.
  }

  // P11.5 audit fix #1 — render Tier-1 plugin promptContext blocks. Each
  // active plugin's `promptContext: [{label, render}]` array contributes
  // a slice; non-empty slices are concatenated into the system prompt.
  // Disabled plugins are filtered at the registry level.
  let pluginContextBlock: string | undefined;
  try {
    const blocks = await pluginPromptContextRegistry.renderAll();
    if (blocks.length > 0) pluginContextBlock = blocks.join("\n\n");
  } catch {
    // Best-effort: never block the turn on a renderer error.
  }

  return { subagentsBlock, pluginsBlock, pluginContextBlock };
}
