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
  /** When the skill became available (migration 0213). Null on rows
   *  predating an activation stamp — treated as "always been here". */
  activatedAt: string | null;
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
  /**
   * Skills that became active AFTER this chat started, and so are
   * deliberately absent from the pinned index above. The chat-runner
   * announces them once in the message history — see
   * `formatNewSkillsNotice`. Empty on a new chat, where the index
   * already covers everything.
   */
  newlyActivated: ReadonlyArray<{ slug: string; description: string }>;
}

/**
 * The one-line announcement a RUNNING chat gets when a skill is
 * activated mid-conversation.
 *
 * It rides the message history rather than the system prompt on
 * purpose: the `## Skills` index sits in the cached prefix, so editing
 * it mid-chat would invalidate the cache for every remaining turn of
 * that chat (CLAUDE.md §11). History is append-only and cache-friendly,
 * so the same information costs one message instead of a re-read of the
 * whole prefix.
 */
export function formatNewSkillsNotice(
  skills: ReadonlyArray<{ slug: string; description: string }>,
): string {
  const lines = skills.map((s) => `- ${s.slug}: ${s.description}`);
  return [
    "New skills became available since this chat started. They are not in the `# Skills` index above — load them by slug with load_skill({slugs}) when a task matches:",
    ...lines,
  ].join("\n");
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
      if (!argsRaw || typeof argsRaw !== "object") continue;
      // `slugs` is the current shape; `slug` is what chats persisted before
      // the tool went bulk. Both must be read — dropping the singular form
      // would silently lose the preload hints of every pre-existing chat.
      const args = argsRaw as { slug?: unknown; slugs?: unknown };
      const candidates = Array.isArray(args.slugs) ? args.slugs : [args.slug];
      for (const s of candidates) {
        if (typeof s === "string" && s.length > 0) slugs.add(s);
      }
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
  args: { loadedSkillSlugs: readonly string[]; chatStartedAt?: string | null },
): Promise<SkillsContext> {
  const empty: SkillsContext = {
    skillsIndexBlock: undefined,
    allowedToolNames: null,
    engagedSkills: [],
    newlyActivated: [],
  };
  const skillsListResult = await execute(registry, adapter, humanCtx, "skills.list", {
    status: "active",
  });
  if (!skillsListResult.ok) return empty;
  const allActive = (skillsListResult.value as { skills: ActiveSkillRow[] }).skills;
  if (allActive.length === 0) return empty;

  // Pin the index to what was active when the chat began. A skill
  // activated since then is real and usable — its tools dispatch, its
  // body loads — it is only kept OUT OF THE CACHED PREFIX, and
  // announced in the history instead. Without the pin, one activation
  // would rewrite the prefix of every open chat and cost a full
  // re-read of it on their next turn.
  const startedAt = args.chatStartedAt ? Date.parse(args.chatStartedAt) : Number.NaN;
  const pinnable = (s: ActiveSkillRow): boolean => {
    if (Number.isNaN(startedAt)) return true; // no chat timestamp: no pin to apply
    if (!s.activatedAt) return true; // pre-0213 row: it has always been here
    const at = Date.parse(s.activatedAt);
    return Number.isNaN(at) || at <= startedAt;
  };
  const activeSkills = allActive.filter(pinnable);
  const newlyActivated = allActive
    .filter((s) => !pinnable(s))
    .map((s) => ({ slug: s.slug, description: s.description }));

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
    "Skills are packaged instructions for specific tasks. Load them with load_skill({slugs}) — pass every skill you already know you need in ONE call. Their guidance enters this conversation and stays for the rest of the chat, so load each skill only once (do not reload one already loaded above).",
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
  // Every active skill is newer than this chat: there is no index to
  // pin, but the preload and engagement below still have to run —
  // otherwise a chat whose only skills are new would advertise them in
  // the notice and then fail to preload their tools when loaded.
  const skillsIndexBlock = activeSkills.length === 0 ? undefined : parts.join("\n");

  // Preloads and engagement read from ALL active skills, not just the
  // pinned ones — a newly activated skill the model loads must get its
  // tools preloaded like any other. The pin governs the prefix only.
  const loadedSet = new Set(args.loadedSkillSlugs);
  const loaded = allActive.filter((s) => loadedSet.has(s.slug));
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
    newlyActivated,
  };
}
