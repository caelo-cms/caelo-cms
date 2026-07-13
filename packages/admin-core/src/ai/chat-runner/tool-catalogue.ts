// SPDX-License-Identifier: MPL-2.0

/**
 * Tool-catalogue assembly: the skill-allowlist intersection (incl. the
 * issue-#106 zero-match fallback), the P10.5 subagent exclusion, the
 * issue-#264 per-spawn allowlist, and the P11.5 Tier-1 plugin-tool
 * folding. Extracted verbatim from the pre-split `chat-runner.ts`.
 */

import { pluginToolsRegistry } from "@caelo-cms/plugin-host";

import type { ChatEngagement } from "@caelo-cms/shared";

import type { ToolDefinition } from "../provider.js";
import type { ToolDescribeState } from "../tools/describe-state.js";
import type { ToolRegistry } from "../tools/index.js";

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
 * allowlist (treating a zero-match allowlist as absent), drops excluded
 * tools, then folds in the active Tier-1 plugin tools.
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
  // issue #106 (step-13 root cause) — an engaged skill's allowlist that
  // matches ZERO live tools is a misconfiguration, never an intent. The
  // step-13 footer walk hit this: "add a footer with navigation links"
  // auto-engaged the `menu-auditor` skill, whose `allowlistedTools` list
  // Query-API op names (`structured_sets.list`, `pages.list`, …) instead of
  // the AI tool names the catalogue uses (`list_structured_sets`,
  // `list_pages`, …). The intersection was empty, so the AI was handed ZERO
  // tools, couldn't call add_module_to_layout, and narrated the footer
  // instead of building it (and the passive-turn nudge correctly couldn't
  // fire — there was nothing to nudge toward). Narrowing the AI to zero
  // tools strands it; treat a zero-match allowlist as absent: fall back to
  // the full catalogue and warn loudly so the broken skill data gets fixed.
  let effectiveAllowed = allowedToolNames;
  if (effectiveAllowed) {
    const matchCount = fullCatalogue.filter((t) => effectiveAllowed!.has(t.name)).length;
    if (matchCount === 0) {
      console.error("[chat-runner] skill-allowlist-zero-match", {
        chatSessionId,
        allowlist: [...effectiveAllowed],
        engagedSkills: engagedSkills.map((e) => e.slug),
        note: "allowlist matched no live tool (likely op-names vs tool-names) — ignoring it",
      });
      effectiveAllowed = null;
    }
  }
  const builtinTools = fullCatalogue.filter((t) => {
    // Run #8 R2b/R5 — skill allowlists narrow WRITE tools only; read
    // tools always pass (see isReadOnlyToolName above). `excluded` and
    // `spawnAllowed` stay hard filters for every tool.
    if (effectiveAllowed && !effectiveAllowed.has(t.name) && !isReadOnlyToolName(t.name))
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
  const result = [
    ...builtinTools,
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
