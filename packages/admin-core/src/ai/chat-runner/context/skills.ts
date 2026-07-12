// SPDX-License-Identifier: MPL-2.0

/**
 * Skills-engagement + post-catalogue system-prompt context blocks. Extracted
 * verbatim from the pre-split `chat-runner.ts` (P10A / P10.5 / P11 / P11.5).
 *
 * `buildSkillsContext` resolves which active skills engage this turn (auto
 * matcher ∪ pinned defaults ∪ per-chat manual overrides) and the allowlist
 * narrowing; it runs BEFORE the tool catalogue is built. `buildPostCatalogueBlocks`
 * renders the subagents / plugins / plugin-promptContext blocks, which depend
 * on the already-filtered tool catalogue and so run AFTER it.
 *
 * NOTE (CLAUDE.md §2 / plan R6): the `engaged_skills` read below uses a raw
 * `adapter.rawAdmin().begin(...)` SELECT. This is a PRE-EXISTING deviation
 * moved here verbatim — it is not introduced by this refactor and is not
 * fixed here (converting it to a named op is a separate follow-up).
 */

import { pluginPromptContextRegistry } from "@caelo-cms/plugin-host";
import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import {
  type CandidateSkill,
  type ChatEngagement,
  type ExecutionContext,
  matchSkills,
  resolveEngagements,
  skillAutoEngagementHints,
} from "@caelo-cms/shared";

export interface SkillsContext {
  skillsBlock: string | undefined;
  allowedToolNames: Set<string> | null;
  engagedSkills: ChatEngagement[];
}

export async function buildSkillsContext(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  humanCtx: ExecutionContext,
  args: { userMessage: string; chipCount: number; chatSessionId: string },
): Promise<SkillsContext> {
  // P10A — load active skills + the user's pinned defaults + the
  // chat's manual overrides; resolve the engaged set; compose a
  // `## Engaged skills` system-prompt chunk + intersect tool
  // catalogue against the union of engaged skills' allowlists.
  let skillsBlock: string | undefined;
  let allowedToolNames: Set<string> | null = null;
  let engagedSkills: ChatEngagement[] = [];
  const skillsListResult = await execute(registry, adapter, humanCtx, "skills.list", {
    status: "active",
  });
  if (skillsListResult.ok) {
    const activeSkills = (
      skillsListResult.value as {
        skills: {
          id: string;
          slug: string;
          displayName: string;
          body: string;
          allowlistedTools: string[];
          hints: unknown;
        }[];
      }
    ).skills;
    const candidates: CandidateSkill[] = activeSkills.map((s) => {
      const parsed = skillAutoEngagementHints.safeParse(s.hints);
      return {
        id: s.id,
        slug: s.slug,
        displayName: s.displayName,
        hints: parsed.success ? parsed.data : { keywords: [], chipTrigger: false, alwaysOn: false },
      };
    });
    const autoMatches = matchSkills({
      userMessage: args.userMessage,
      chipCount: args.chipCount,
      skills: candidates,
    });
    const pinnedR = await execute(registry, adapter, humanCtx, "skills.list_pin_defaults", {});
    const pinned = pinnedR.ok
      ? (
          pinnedR.value as {
            pinDefaults: { skillId: string; slug: string; displayName: string }[];
          }
        ).pinDefaults
      : [];
    // Manual overrides + sticky auto-engagements on the chat session
    // row. NULL or {} → no overrides yet.
    const sessRows = (await adapter.rawAdmin().begin(async (tx) => {
      await tx.unsafe(`SET LOCAL caelo.actor_kind = 'system'`);
      return await tx`SELECT engaged_skills, auto_engaged_skills FROM chat_sessions
        WHERE id = ${args.chatSessionId}::uuid LIMIT 1`;
    })) as unknown as { engaged_skills: unknown; auto_engaged_skills: unknown }[];
    const stored = sessRows[0]?.engaged_skills;

    // 0125 — sticky engagement: the matcher scores ONLY the current
    // message, so mid-flow answers ("B — Light refresh", "ja") carry
    // no keywords and the skill that owns the flow would silently
    // drop out between turns (live-hit 2026-07-12: site-migrate
    // vanished for the scope turn and the AI queued a full crawl
    // unasked). Skills that auto-engaged earlier in THIS chat
    // re-engage — filtered against the currently ACTIVE set so a
    // deactivated skill cannot zombie back, and still subject to
    // manual disengagement via resolveEngagements.
    const storedAuto = sessRows[0]?.auto_engaged_skills;
    const activeById = new Map(candidates.map((c) => [c.id, c]));
    const sticky = (Array.isArray(storedAuto) ? storedAuto : [])
      .filter(
        (e): e is { skillId: string } =>
          typeof e === "object" &&
          e !== null &&
          typeof (e as { skillId?: unknown }).skillId === "string",
      )
      .filter((e) => activeById.has(e.skillId))
      .filter((e) => !autoMatches.some((m) => m.skillId === e.skillId))
      .map((e) => {
        const c = activeById.get(e.skillId);
        if (!c) throw new Error("unreachable: filtered above");
        return {
          skillId: c.id,
          slug: c.slug,
          displayName: c.displayName,
          score: 1,
          rationale: "engaged earlier in this chat",
        };
      });
    const autoWithSticky = [...autoMatches, ...sticky];
    const manualOverrides: Array<{
      skillId: string;
      slug: string;
      displayName: string;
      intent: "engage" | "disengage";
    }> | null = Array.isArray(stored)
      ? (stored as {
          skillId: string;
          slug: string;
          displayName: string;
          intent: "engage" | "disengage";
        }[])
      : null;
    engagedSkills = resolveEngagements({
      autoMatches: autoWithSticky,
      manualOverrides,
      pinnedSkills: pinned,
    });

    // Persist the auto-engaged set for the next turn's stickiness.
    // Same raw-adapter deviation as the read above (see file NOTE).
    const nextAuto = engagedSkills
      .filter((e) => e.source === "auto")
      .map((e) => ({ skillId: e.skillId, slug: e.slug, displayName: e.displayName }));
    await adapter.rawAdmin().begin(async (tx) => {
      await tx.unsafe(`SET LOCAL caelo.actor_kind = 'system'`);
      await tx`UPDATE chat_sessions
        SET auto_engaged_skills = (${JSON.stringify(nextAuto)}::text)::jsonb
        WHERE id = ${args.chatSessionId}::uuid`;
    });

    if (engagedSkills.length > 0) {
      // Concatenate skill bodies, tagged with the slug + source so the
      // AI knows which guidance is which.
      const bodyById = new Map(activeSkills.map((s) => [s.id, s.body]));
      const lines = engagedSkills.map((e) => {
        const body = bodyById.get(e.skillId) ?? "";
        return `## Skill: ${e.slug} (${e.source}${e.rationale ? ` — ${e.rationale}` : ""})\n${body}`;
      });
      skillsBlock = ["# Engaged skills", ...lines].join("\n\n");

      // Allowlist intersection: when ANY engaged skill defines an
      // allowlist, the AI's tool catalogue narrows to the UNION of
      // those allowlists. When none do, the full catalogue stays.
      //
      // v0.2.48 — alwaysOn-only engagements DO NOT contribute to the
      // narrowing. An alwaysOn skill engages on every turn; if it
      // declares a narrow allowlist (e.g. brand-voice-guard's
      // [site_memory_propose]), every chat where no other skill
      // engages would be restricted to that single tool — the AI
      // ends up unable to do real work. alwaysOn allowlists are
      // treated as advisory: the skill body still loads, but tool
      // access stays wide.
      //
      // Detection: matchSkills sets `rationale = "always-on"` exactly
      // when only the alwaysOn flag fired (no chip trigger, no
      // keyword match). When other reasons fire, they're appended
      // with "; " separators, so any rationale ≠ "always-on"
      // indicates a real signal beyond the alwaysOn floor.
      const allowlists = engagedSkills
        .filter((e) => !(e.source === "auto" && e.rationale === "always-on"))
        .map((e) => activeSkills.find((s) => s.id === e.skillId)?.allowlistedTools ?? [])
        .filter((arr) => arr.length > 0);
      if (allowlists.length > 0) {
        allowedToolNames = new Set(allowlists.flat());
      }
    }
  }
  return { skillsBlock, allowedToolNames, engagedSkills };
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
  skillsBlock: string | undefined;
}): Promise<PostCatalogueBlocks> {
  const { registry, adapter, aiCtx, filteredTools, excluded, userMessage, skillsBlock } = args;

  // P10.5 #5 — subagents hint chunk. Emitted when (a) spawn tools are
  // visible in this turn's catalogue (so we never tell the AI to use
  // a tool it can't see — subagents themselves don't get the hint
  // because their own catalogue strips spawn_subagent) AND (b) the
  // user's message contains parallel-work cues OR an engaged skill
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
    const skillMentionsSubagents = skillsBlock?.toLowerCase().includes("spawn_subagent");
    if (matched || skillMentionsSubagents) {
      subagentsBlock = [
        "# Subagents",
        "You can fan out parallel reasoning angles via `spawn_subagent` (single) or `spawn_subagents` (parallel batch). Each child is its own chat-runner turn with its own auto-engaged skill — its task wording drives which skill engages (e.g. role='qa', task='QA the article' → engages qa-check; role='menu-auditor' → engages menu-auditor).",
        "Use when the work has multiple distinct perspectives that benefit from isolated context (audit + propose, QA + legal + brand-voice, US-perspective + EU-perspective).",
        "DO NOT use for one-line edits or quick lookups — those are regular tool calls. Subagents earn their cost when each angle is multi-step.",
        "Each subagent returns a parsed verdict (or tree, or freeform). Ingest the results, then decide your next move.",
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
