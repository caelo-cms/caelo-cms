// SPDX-License-Identifier: MPL-2.0

/**
 * Tool-catalogue assembly: the skill-allowlist resolution (issue #301
 * op→tool translation; the issue-#106 "never strand the AI at zero
 * tools" guarantee), the P10.5 subagent exclusion, the issue-#264
 * per-spawn allowlist, and the P11.5 Tier-1 plugin-tool folding.
 * Extracted from the pre-split `chat-runner.ts`.
 */

import { pluginToolsRegistry } from "@caelo-cms/plugin-host";

import type { ChatEngagement } from "@caelo-cms/shared";

import type { ToolDefinition } from "../provider.js";
import { CORE_TOOL_NAMES } from "../tools/core-tools.js";
import type { ToolRegistry } from "../tools/index.js";
import { resolveAllowlistEntries } from "./allowlist-mapping.js";

/**
 * A catalogue entry in provider-`tools` shape. `gated` (Plan B) is an
 * internal marker the chat-runner reads to attach the SDK `execute`
 * (propose → execute_proposal); it rides alongside the provider fields and is
 * ignored by the provider's SDK-tool builder.
 */
export type FilteredTool = ToolDefinition & {
  gated?: { proposeOp: string; executeOp: string };
};

/**
 * Run #8 R2b/R5 — read-only tool classifier, by the repo's naming
 * convention (same convention the v0.6.0 auto-recovery path relies on).
 *
 * Why: engaged-skill allowlists are curated around a workflow's WRITE
 * tools (compose-page lists edit_module, set_page_module_content, …) and
 * historically also stripped every read tool. That blinded the AI
 * mid-session: in migration run #8 the module-lookup tools vanished when
 * a skill engaged, so the AI edited the wrong module (R5), and rebuild
 * subagents whose seed message matched a skill lost inspect_page_render /
 * list_modules / get_content_instance entirely (R2b). Per CLAUDE.md §11
 * "read surfaces are powerful — the AI needs broad read to plan good
 * writes", a skill allowlist now narrows WRITE tools only; read tools
 * always stay in the catalogue. Explicit per-spawn narrowing
 * (`spawnAllowed`) and `excluded` remain HARD filters — a parent that
 * narrows a review subagent to three read tools still gets exactly those.
 */
const READ_ONLY_TOOL_NAME = /^(list_|get_|inspect_|find_|screenshot_|check_)/;

/** True when the tool is read-only by naming convention (list_/get_/inspect_/find_/screenshot_/check_). */
export function isReadOnlyToolName(name: string): boolean {
  return READ_ONLY_TOOL_NAME.test(name);
}

/**
 * Run #10 D2 — the subagent structured-result tool. Registered in the
 * default registry so child sessions can dispatch it, but visible ONLY
 * when the turn carries a `subagentResultCapture` (i.e. it IS a child
 * session). See `resolveExcludedToolNames`.
 */
const SUBAGENT_RESULT_TOOL_NAME = "submit_result";

/**
 * Run #10 D2 — computes the effective excluded-tool set for a turn.
 * Normal chats get `submit_result` added to the exclusions (there is no
 * parent listening for a structured result); subagent child turns
 * (hasResultCapture=true) keep the caller's exclusions as-is so the
 * tool stays visible. Pure so the gating is unit-testable.
 */
export function resolveExcludedToolNames(
  excluded: ReadonlySet<string> | undefined,
  hasResultCapture: boolean,
): ReadonlySet<string> | undefined {
  const extra: string[] = [];
  // Operator / A/B toggle: with subagents disabled, strip the spawn tools from
  // every turn's catalogue so the model does the work itself (single-agent).
  // Paired with the static `## Subagents` prompt block being suppressed under
  // the same env in composeSystemPromptChunks.
  if (process.env.CAELO_DISABLE_SUBAGENTS === "1") {
    extra.push("spawn_subagent", "spawn_subagents");
  }
  // Normal (non-child) turns never expose the subagent-only result tool.
  if (!hasResultCapture) extra.push(SUBAGENT_RESULT_TOOL_NAME);
  if (extra.length === 0) return excluded;
  return new Set([...(excluded ?? []), ...extra]);
}

/**
 * Run #8 R5 — per-session catalogue determinism watchdog. The catalogue
 * is rebuilt every turn; when a tool that was present on the previous
 * turn disappears, that is either an intended narrowing (skill engaged,
 * subagent exclusion) or a bug — either way it must be LOUD in the logs,
 * because run #8's mid-session toolset shrink was silent and surfaced
 * only as "the AI edited the wrong module". Bounded map so long-lived
 * processes don't grow without limit.
 */
const lastCatalogueBySession = new Map<string, ReadonlySet<string>>();
const CATALOGUE_WATCH_MAX_SESSIONS = 1000;

function warnOnDisappearedTools(chatSessionId: string, names: readonly string[]): void {
  const next = new Set(names);
  const prev = lastCatalogueBySession.get(chatSessionId);
  if (prev) {
    const disappeared = [...prev].filter((n) => !next.has(n));
    if (disappeared.length > 0) {
      console.error("[chat-runner] tool-catalogue-shrank", {
        chatSessionId,
        disappeared,
        previousCount: prev.size,
        currentCount: next.size,
      });
    }
  }
  if (!prev && lastCatalogueBySession.size >= CATALOGUE_WATCH_MAX_SESSIONS) {
    // Crude eviction: drop the oldest insertion. Sessions are long-lived
    // relative to turns, so FIFO is close enough to LRU here.
    const oldest = lastCatalogueBySession.keys().next().value;
    if (oldest !== undefined) lastCatalogueBySession.delete(oldest);
  }
  lastCatalogueBySession.set(chatSessionId, next);
}

/**
 * Builds the per-turn tool catalogue: takes the full registry catalogue
 * (state-aware descriptions), tags each tool `alwaysLoaded` when it is in
 * the core set OR an engaged skill's allowlist (a PRELOAD hint — its
 * schema ships up front so the model skips a tool-search round-trip),
 * drops only the hard-scoped tools (`excluded` depth cap + `spawnAllowed`
 * per-spawn narrowing), then folds in the active Tier-1 plugin tools.
 * Skill allowlists NEVER remove a tool — everything not preloaded stays
 * reachable via Tool Search.
 */
export function buildToolCatalogue(args: {
  tools: ToolRegistry;
  allowedToolNames: Set<string> | null;
  engagedSkills: ChatEngagement[];
  excluded: ReadonlySet<string> | undefined;
  /**
   * issue #264 — per-spawn allowlist from the parent's subagent spec.
   * A HARD filter (like `excluded`), never the zero-match fallback the
   * skill allowlist gets: the spawn handler validates it against live
   * tool names before the child turn starts, so a zero-match here is
   * a bug upstream — silently widening back to the full catalogue
   * would grant write tools to a subagent the parent asked to narrow.
   */
  spawnAllowed?: ReadonlySet<string>;
  chatSessionId: string;
}): FilteredTool[] {
  const { tools, allowedToolNames, engagedSkills, excluded, spawnAllowed, chatSessionId } = args;

  const fullCatalogue = tools.catalogue();
  // Skill allowlists are PRELOAD HINTS, not filters (2026-07 Tool Search
  // rework). An engaged skill's `allowlistedTools` name the tools its
  // workflow leans on; we keep their full schemas LOADED for the turn
  // (so the model reaches them without a tool-search round-trip) and let
  // everything else defer behind the search surface. A skill NEVER
  // removes a tool from the catalogue anymore.
  //
  // Why the reversal: the old hard-narrowing forced every skill to
  // enumerate every write it might touch; a miss stranded the model.
  // Under Tool Search that got worse — the model KNOWS more tools exist
  // (the playbook says so) and burned search STORMS hunting for a write
  // the skill forgot to list (one nested-CTA turn fired 11 back-to-back
  // toolSearch calls for create_content_instance / remove_module_from).
  // Deferral already gives the "focus" that narrowing was for, so the
  // narrowing was pure downside. Real scoping (subagent read-only, the
  // depth cap) is enforced by the HARD filters `spawnAllowed` /
  // `excluded` below — those are unchanged.
  //
  // Entries still resolve exact-first then via the issue-#301 op→tool
  // table (seeded skills carry op notation like `structured_sets.list`);
  // unresolved entries are logged so a typo'd skill row is visible.
  const skillPreload = new Set<string>();
  if (allowedToolNames) {
    const liveNames = new Set<string>(fullCatalogue.map((t) => t.name));
    for (const { spec } of pluginToolsRegistry.list()) liveNames.add(spec.name);
    const resolution = resolveAllowlistEntries(allowedToolNames, liveNames);
    for (const n of resolution.resolvedToolNames) skillPreload.add(n);
    for (const u of resolution.unresolved) {
      console.error("[chat-runner] skill-allowlist-unresolved-entry", {
        chatSessionId,
        entry: u.entry,
        suggestion: u.suggestion,
        engagedSkills: engagedSkills.map((e) => e.slug),
      });
    }
  }
  // Loaded up front = the always-on core set PLUS the engaged skills'
  // preload hints. Everything else is reachable via tool search.
  const preload = new Set<string>([...CORE_TOOL_NAMES, ...skillPreload]);
  const builtinTools = fullCatalogue.filter((t) => {
    // Skill allowlists no longer narrow — only the HARD scoping filters
    // do: `excluded` (subagent depth cap) and `spawnAllowed` (per-spawn
    // narrowing a parent set for a child). Both stay authoritative.
    if (excluded?.has(t.name)) return false;
    if (spawnAllowed && !spawnAllowed.has(t.name)) return false;
    return true;
  });
  // P11.5 commit 2 — fold Tier-1 plugin-registered tools into the catalogue.
  // Plugins declare their tools in `manifest.tools[]`; the host loader
  // registers them into `pluginToolsRegistry` at activation. The chat-runner
  // discovers them per turn so disabling a plugin removes its tools from
  // the AI's catalogue on the next call.
  const pluginTools = pluginToolsRegistry.list().filter(({ spec }) => {
    if (excluded?.has(spec.name)) return false;
    if (spawnAllowed && !spawnAllowed.has(spec.name)) return false;
    return true;
  });
  // Tool-search hint: tools in `preload` (the core set + this turn's
  // engaged-skill hints) keep full definitions in every request; the
  // rest defer behind the provider's tool-search surface.
  const result: FilteredTool[] = [
    ...builtinTools.map((t) => (preload.has(t.name) ? { ...t, alwaysLoaded: true } : t)),
    ...pluginTools.map(({ spec }) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputJsonSchema,
      ...(preload.has(spec.name) ? { alwaysLoaded: true } : {}),
    })),
  ];
  warnOnDisappearedTools(
    chatSessionId,
    result.map((t) => t.name),
  );
  return result;
}
