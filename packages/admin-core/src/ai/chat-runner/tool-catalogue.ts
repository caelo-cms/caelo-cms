// SPDX-License-Identifier: MPL-2.0

/**
 * Tool-catalogue assembly: the core-set tagging, the P10.5 subagent
 * exclusion, the issue-#264 per-spawn allowlist, and the P11.5 Tier-1
 * plugin-tool folding.
 * Extracted from the pre-split `chat-runner.ts`.
 */

import { pluginToolsRegistry } from "@caelo-cms/plugin-host";

import type { ToolDefinition } from "../provider.js";
import { CORE_TOOL_NAMES } from "../tools/core-tools.js";
import type { GatedToolSpec } from "../tools/dispatch.js";
import type { ToolRegistry } from "../tools/index.js";
import { installUnavailableToolNames } from "../tools/install-availability.js";

/**
 * A catalogue entry in provider-`tools` shape. `gated` (Plan B) is an
 * internal marker the chat-runner reads to attach the SDK `execute`
 * (propose → execute_proposal); it rides alongside the provider fields and is
 * ignored by the provider's SDK-tool builder.
 */
export type FilteredTool = ToolDefinition & {
  gated?: GatedToolSpec;
  /** #388 — a plugin tool that declared `approvalMode` in its spec. The
   *  chat-runner attaches an SDK `execute` that dispatches the plugin
   *  operation only after the Owner's in-chat Approve — plugin tools no
   *  longer bypass the approvals surface. */
  pluginGated?: { pluginSlug: string; operationName: string };
  /** Host callback: persist the external installation binding before displaying a card. */
  prepareApproval?: (toolCallId: string, args: unknown) => Promise<void>;
};

/**
 * Run #8 R2b/R5 — read-only tool classifier, by the repo's naming
 * convention (same convention the v0.6.0 auto-recovery path relies on).
 *
 * Why: engaged-skill allowlists are curated around a workflow's WRITE
 * tools (compose-page lists update_modules_many, set_page_module_content_many, …) and
 * historically also stripped every read tool. That blinded the AI
 * mid-session: in migration run #8 the module-lookup tools vanished when
 * a skill engaged, so the AI edited the wrong module (R5), and rebuild
 * subagents whose seed message matched a skill lost inspect_page_render /
 * list_modules / get_content_instance entirely (R2b). Per CLAUDE.md §11
 * "read surfaces are powerful — the AI needs broad read to plan good
 * writes". The 2026-07 Tool Search rework then went further: skill
 * allowlists no longer narrow ANYTHING (everything outside the core set,
 * read AND write, defers behind Tool Search; nothing is removed), which
 * permanently closed the read-tool blinding above. Explicit per-spawn narrowing
 * (`spawnAllowed`) and `excluded` remain the only HARD filters — a parent
 * that narrows a review subagent to three read tools still gets exactly those.
 */

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
  // Tools that cannot run on this install kind (inspect_built_page off GCP)
  // are never offered — paired with the playbook leaving them unnamed.
  extra.push(...installUnavailableToolNames(process.env));
  // Normal (non-child) turns never expose the subagent-only result tool.
  if (!hasResultCapture) extra.push(SUBAGENT_RESULT_TOOL_NAME);
  if (extra.length === 0) return excluded;
  return new Set([...(excluded ?? []), ...extra]);
}

/**
 * Run #8 R5 — per-session catalogue determinism watchdog. The catalogue
 * is rebuilt every turn; when a tool that was present on the previous
 * turn disappears, that is either an intended narrowing (subagent
 * exclusion, a plugin switched off) or a bug — either way it must be LOUD in the logs,
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
 * Builds the per-turn tool catalogue: takes the full registry catalogue,
 * tags the core set (`CORE_TOOL_NAMES`) `alwaysLoaded`, drops only the
 * hard-scoped tools (`excluded` depth cap + `spawnAllowed` per-spawn
 * narrowing), then folds in the active Tier-1 plugin tools.
 *
 * Nothing about the conversation shapes the result. The tool list is the
 * very front of the provider's prompt prefix (tools -> system -> messages),
 * so a tool list that changed between two turns of a chat made the provider
 * re-write the chat's whole history to its cache at full price. That is what
 * the skill preload did: a skill loaded in one turn marked its allowlisted
 * tools `alwaysLoaded` from the NEXT turn on, and every such turn started
 * with a cache miss over everything (e2e-livedit runs 2026-10-26: 100–170k
 * tokens written per affected turn, 14–19 % of a run's cost). A skill's tools
 * stay reachable the way every deferred tool is: tool search, whose loaded
 * definitions the provider keeps for the rest of the chat.
 */
export function buildToolCatalogue(args: {
  tools: ToolRegistry;
  excluded: ReadonlySet<string> | undefined;
  /**
   * issue #264 — per-spawn allowlist from the parent's subagent spec.
   * A HARD filter (like `excluded`): the spawn handler validates it against
   * live tool names before the child turn starts, so a zero-match here is
   * a bug upstream — silently widening back to the full catalogue would
   * grant write tools to a subagent the parent asked to narrow.
   */
  spawnAllowed?: ReadonlySet<string>;
  chatSessionId: string;
}): FilteredTool[] {
  const { tools, excluded, spawnAllowed, chatSessionId } = args;

  const fullCatalogue = tools.catalogue();
  const builtinTools = fullCatalogue.filter((t) => {
    // Only the HARD scoping filters remove a tool: `excluded` (subagent
    // depth cap) and `spawnAllowed` (per-spawn narrowing a parent set for
    // a child).
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
  // Tool-search hint: the core set keeps full definitions in every
  // request; the rest defer behind the provider's tool-search surface.
  const result: FilteredTool[] = [
    ...builtinTools.map((t) => (CORE_TOOL_NAMES.has(t.name) ? { ...t, alwaysLoaded: true } : t)),
    ...pluginTools.map(({ pluginSlug, spec }) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputJsonSchema,
      ...(CORE_TOOL_NAMES.has(spec.name) ? { alwaysLoaded: true } : {}),
      // #388 — carry the plugin's approval declaration into the
      // catalogue so the chat-runner can wire the SDK gate; without
      // this, plugin tools ran unqueued and unapproved on every call.
      ...(spec.approvalMode
        ? {
            approvalMode: spec.approvalMode,
            pluginGated: { pluginSlug, operationName: spec.operationName },
          }
        : {}),
    })),
  ];
  warnOnDisappearedTools(
    chatSessionId,
    result.map((t) => t.name),
  );
  return result;
}
