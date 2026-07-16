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
import type { ToolDescribeState } from "../tools/describe-state.js";
import type { ToolRegistry } from "../tools/index.js";
import { resolveAllowlistEntries } from "./allowlist-mapping.js";

/** A catalogue entry in provider-`tools` shape (== ToolDefinition). */
export type FilteredTool = ToolDefinition;

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
 * Run #9 R7 — orchestration tools are skill-allowlist-immune, like read
 * tools. Skill allowlists are curated around a workflow's DOMAIN write
 * tools (compose-page lists edit_module, create_page, …); none of them
 * predates the 0132 subagent contract, so none lists spawn_subagent —
 * and the site-migrate orchestrator lost its fan-out primitive the
 * moment a co-engaged skill (compose-page via sticky engagement)
 * contributed an allowlist ("Mir steht kein Subagenten-Werkzeug zur
 * Verfügung"). A skill opting into subagents in its BODY while the
 * allowlist strips the TOOL is exactly the #251 drift class; the fix
 * is structural, not another per-skill allowlist migration.
 *
 * `excluded` (the P10.5 depth cap — child sessions never see spawn
 * tools) and `spawnAllowed` (explicit per-spawn narrowing) remain HARD
 * filters, so this immunity never grants a subagent the ability to
 * spawn its own children.
 */
const ORCHESTRATION_TOOL_NAMES = new Set(["spawn_subagent", "spawn_subagents"]);

/** True when the tool is a subagent-orchestration primitive (spawn_subagent / spawn_subagents). */
export function isOrchestrationToolName(name: string): boolean {
  return ORCHESTRATION_TOOL_NAMES.has(name);
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
  if (hasResultCapture) return excluded;
  return new Set([...(excluded ?? []), SUBAGENT_RESULT_TOOL_NAME]);
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
 * Builds the per-turn tool catalogue: starts from the full registry
 * catalogue (state-aware descriptions), narrows by the engaged-skill
 * allowlist (entries resolved exact-first then via the issue-#301
 * op→tool translation table; a zero-resolution allowlist keeps the
 * full catalogue and emits a `skill-allowlist-defect` event), drops
 * excluded tools, then folds in the active Tier-1 plugin tools.
 */
export function buildToolCatalogue(args: {
  tools: ToolRegistry;
  toolDescribeState: ToolDescribeState;
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
  const {
    tools,
    toolDescribeState,
    allowedToolNames,
    engagedSkills,
    excluded,
    spawnAllowed,
    chatSessionId,
  } = args;

  const fullCatalogue = tools.catalogue(toolDescribeState);
  // issue #106 → issue #301 — allowlist entries are resolved, never
  // string-matched blind. Seeded skills (migration 0033) carried
  // Query-API op names (`structured_sets.list`, `pages.list`, …) while
  // the catalogue uses AI tool names (`list_structured_sets`,
  // `list_pages`, …); the old code intersected the raw strings, got
  // zero matches, and silently widened back to the full catalogue —
  // run #15 hit that hidden fallback 5× in one session, shipping the
  // whole catalogue on turns the skill meant to narrow (CLAUDE.md §2).
  // Now each entry resolves via exact tool-name match first, then the
  // explicit op→tool translation table (allowlist-mapping.ts):
  //   - the resolved subset applies as the allowlist;
  //   - unresolved entries are logged individually with a nearest-name
  //     suggestion (`skill-allowlist-unresolved-entry`);
  //   - an allowlist that resolves to ZERO live tools is a
  //     skill-definition defect: the chat keeps the full catalogue so
  //     the AI is never stranded with zero tools (the original #106
  //     failure), but the defect is a structured `skill-allowlist-defect`
  //     event — save-time validation in the skills ops (issue #301)
  //     rejects such rows, so reaching this branch means a pre-0157 row
  //     or hand-edited data. Surfacing this event in the Owner skills
  //     panel (/security/skills) is the tracked follow-up on issue #301.
  let effectiveAllowed: Set<string> | null = null;
  if (allowedToolNames) {
    const liveNames = new Set<string>(fullCatalogue.map((t) => t.name));
    for (const { spec } of pluginToolsRegistry.list()) liveNames.add(spec.name);
    const resolution = resolveAllowlistEntries(allowedToolNames, liveNames);
    for (const u of resolution.unresolved) {
      console.error("[chat-runner] skill-allowlist-unresolved-entry", {
        chatSessionId,
        entry: u.entry,
        suggestion: u.suggestion,
        engagedSkills: engagedSkills.map((e) => e.slug),
      });
    }
    if (resolution.resolvedToolNames.size > 0) {
      effectiveAllowed = new Set(resolution.resolvedToolNames);
    } else if (resolution.unresolved.length > 0) {
      console.error("[chat-runner] skill-allowlist-defect", {
        chatSessionId,
        allowlist: [...allowedToolNames],
        unresolved: resolution.unresolved,
        engagedSkills: engagedSkills.map((e) => e.slug),
        note: "allowlist resolved to zero live tools — skill row is defective; catalogue stays full so the chat keeps working. Fix the skill's allowlistedTools (skills.set now rejects unknown entries).",
      });
    }
    // else: every entry was context-served (glossary/style-guide/site-
    // memory reads that live in the system prompt, not the catalogue) —
    // there is nothing to narrow, which matches the skill's intent.
  }
  const builtinTools = fullCatalogue.filter((t) => {
    // Run #8 R2b/R5 — skill allowlists narrow WRITE tools only; read
    // tools always pass (see isReadOnlyToolName above). Run #9 R7 —
    // the spawn tools pass too (see ORCHESTRATION_TOOL_NAMES above).
    // `excluded` and `spawnAllowed` stay hard filters for every tool.
    if (
      effectiveAllowed &&
      !effectiveAllowed.has(t.name) &&
      !isReadOnlyToolName(t.name) &&
      !isOrchestrationToolName(t.name)
    )
      return false;
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
    if (effectiveAllowed && !effectiveAllowed.has(spec.name) && !isReadOnlyToolName(spec.name))
      return false;
    if (excluded?.has(spec.name)) return false;
    if (spawnAllowed && !spawnAllowed.has(spec.name)) return false;
    return true;
  });
  // Tool-search hint: core workflow tools keep full definitions in
  // every request (see core-tools.ts); the rest may be deferred behind
  // the provider's tool-search surface. Plugin tools are long-tail by
  // definition — always deferrable.
  const result: FilteredTool[] = [
    ...builtinTools.map((t) => (CORE_TOOL_NAMES.has(t.name) ? { ...t, alwaysLoaded: true } : t)),
    ...pluginTools.map(({ spec }) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputJsonSchema,
    })),
  ];
  warnOnDisappearedTools(
    chatSessionId,
    result.map((t) => t.name),
  );
  return result;
}
