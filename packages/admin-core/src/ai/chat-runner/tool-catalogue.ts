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
    if (effectiveAllowed && !effectiveAllowed.has(t.name)) return false;
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
    if (effectiveAllowed && !effectiveAllowed.has(spec.name)) return false;
    if (excluded?.has(spec.name)) return false;
    if (spawnAllowed && !spawnAllowed.has(spec.name)) return false;
    return true;
  });
  return [
    ...builtinTools,
    ...pluginTools.map(({ spec }) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputJsonSchema,
    })),
  ];
}
