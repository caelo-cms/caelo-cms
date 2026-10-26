// SPDX-License-Identifier: MPL-2.0

/**
 * Retired tool names and renamed bulk-wrapper keys — the one explicit
 * alias table.
 *
 * Why this exists: the always-loaded tool set shrank by retiring every
 * singular write tool that had a bulk twin (CLAUDE.md §11 — singular is the
 * n=1 case of bulk) and by giving every bulk tool the same wrapper key,
 * `items`. Calls written against the old names keep arriving: chat history
 * the model copies from, skills and subagent specs that name a tool,
 * external Power-MCP agents, approval rows queued before the rename, e2e
 * fixtures. Each of those must still land on the tool that now does the
 * job, with arguments that tool accepts.
 *
 * Why it is NOT a silent default (CLAUDE.md §2): every entry is listed here
 * by name with its exact argument rewrite, every use logs
 * `[tool.alias-used] old -> new`, and nothing outside these two tables is
 * ever guessed. The aliases are hidden from the catalogue (`catalogue()`,
 * Power-MCP tools/list, the core set) so the model is never offered two
 * tools for one job; they only catch calls that already use an old name.
 *
 * Seams that consult it: `ToolRegistry.get` / `dispatch` (dispatch.ts —
 * covers chat, Power-MCP, subagents, approval re-dispatch), the AI SDK
 * `repairToolCall` hook (providers/_sdk-shared.ts), skill allowlists
 * (chat-runner/allowlist-mapping.ts) and subagent `allowedToolNames`
 * (spawn-subagent.ts).
 */

/** One retired tool: the live tool that replaced it and how its args map. */
export interface RetiredTool {
  /** The live tool name that now does this job. */
  readonly target: string;
  /** Rewrites an old-shape argument object into the target's shape. */
  readonly adapt: (args: unknown) => unknown;
}

/** Wraps a singular call's args as the one item of a bulk call. */
function asOneItem(args: unknown): { items: unknown[] } {
  return { items: [args] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Retired tool name -> its replacement. A non-object argument is passed
 * through inside the new shape unchanged, so the target's Zod parse rejects
 * it with its own AI-actionable message instead of this layer inventing
 * values.
 */
export const RETIRED_TOOLS: Readonly<Record<string, RetiredTool>> = {
  edit_module: { target: "update_modules_many", adapt: asOneItem },
  set_content_instance_values: { target: "set_content_instance_values_many", adapt: asOneItem },
  set_page_module_content: { target: "set_page_module_content_many", adapt: asOneItem },
  create_content_instance: { target: "create_content_instances", adapt: asOneItem },
  autofill_page_seo: { target: "autofill_page_seo_many", adapt: asOneItem },
  delete_content_instance: { target: "delete_content_instances", adapt: asOneItem },
  set_page_seo: { target: "set_page_seo_many", adapt: asOneItem },
  set_media_alt: { target: "set_media_alt_many", adapt: asOneItem },
  set_media_source: { target: "set_media_source_many", adapt: asOneItem },
  // The singular carried `context` per call; the bulk tool takes one shared
  // `context` next to `items`.
  optimize_page_seo: {
    target: "bulk_optimize_seo",
    adapt: (args) => {
      if (!isRecord(args)) return asOneItem(args);
      const { context, ...item } = args;
      return { items: [item], ...(context !== undefined ? { context } : {}) };
    },
  },
  // reorder_module moved within the current block: move_module with no
  // `toBlockName` does exactly that; `direction` (up | down | index) is
  // move_module's `position`.
  reorder_module: {
    target: "move_module",
    adapt: (args) => {
      if (!isRecord(args)) return args;
      const { direction, ...rest } = args;
      return { ...rest, ...(direction !== undefined ? { position: direction } : {}) };
    },
  },
};

/**
 * Live tool -> { old wrapper key -> new key }. Every bulk tool whose
 * top-level array holds per-item objects calls that array `items`; these are
 * the keys they used before. Arrays of plain ids (`pageIds`, `moduleIds`)
 * keep their names and are not listed.
 */
export const ARG_RENAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  update_modules_many: { updates: "items" },
  update_pages_many: { updates: "items" },
  delete_pages_many: { deletions: "items" },
  bulk_optimize_seo: { updates: "items" },
  bulk_create_redirects: { redirects: "items" },
  create_content_instances: { instances: "items" },
};

/** The outcome of {@link resolveToolCall}. */
export interface ResolvedToolCall {
  /** The live tool to run. */
  readonly name: string;
  /** Arguments in that tool's current shape. */
  readonly args: unknown;
  /** Set when `name` was reached through a retired name. */
  readonly retiredFrom?: string;
  /** Old wrapper keys rewritten to their current name (`updates->items`). */
  readonly renamedKeys: readonly string[];
}

/**
 * The live tool name for `name`: `name` itself unless it is retired. Pure,
 * no logging — callers that act on the answer log via
 * {@link resolveToolCall} or {@link canonicalToolNames}.
 */
export function liveToolNameFor(name: string): string {
  return RETIRED_TOOLS[name]?.target ?? name;
}

/** Applies {@link ARG_RENAMES} for `toolName`; returns the renamed keys. */
function renameKeys(toolName: string, args: unknown): { args: unknown; renamed: string[] } {
  const renames = ARG_RENAMES[toolName];
  if (!renames || !isRecord(args)) return { args, renamed: [] };
  const renamed: string[] = [];
  let out: Record<string, unknown> = args;
  for (const [from, to] of Object.entries(renames)) {
    // Both present = a genuinely malformed call: leave it to the strict Zod
    // parse to name the stray key rather than picking one silently.
    if (from in out && !(to in out)) {
      const { [from]: value, ...rest } = out;
      out = { ...rest, [to]: value };
      renamed.push(`${from}->${to}`);
    }
  }
  return { args: out, renamed };
}

/**
 * Resolves a tool call against the alias tables. `isLive` says whether a
 * name is a registered tool. Returns `null` for a name that is neither live
 * nor retired (the caller's own unknown-tool path applies). Logs every alias
 * and key rename it applies.
 *
 * @param source - where the call came from, for the log line (e.g. `dispatch`).
 */
export function resolveToolCall(
  name: string,
  args: unknown,
  isLive: (name: string) => boolean,
  source: string,
): ResolvedToolCall | null {
  let liveName = name;
  let liveArgs = args;
  let retiredFrom: string | undefined;
  if (!isLive(name)) {
    const retired = RETIRED_TOOLS[name];
    if (!retired || !isLive(retired.target)) return null;
    liveName = retired.target;
    liveArgs = retired.adapt(args);
    retiredFrom = name;
    console.warn(`[tool.alias-used] ${name} -> ${liveName} (${source})`);
  }
  const { args: renamedArgs, renamed } = renameKeys(liveName, liveArgs);
  if (renamed.length > 0) {
    console.warn(`[tool.alias-used] ${liveName} args ${renamed.join(", ")} (${source})`);
  }
  return {
    name: liveName,
    args: renamedArgs,
    ...(retiredFrom ? { retiredFrom } : {}),
    renamedKeys: renamed,
  };
}

/**
 * Maps a list of tool names (a subagent's `allowedToolNames`, a skill
 * preload list) to live names: retired names become their target, order
 * kept, duplicates dropped. Logs each rewrite.
 *
 * @param source - where the list came from, for the log line.
 */
export function canonicalToolNames(names: Iterable<string>, source: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const live = liveToolNameFor(name);
    if (live !== name) console.warn(`[tool.alias-used] ${name} -> ${live} (${source})`);
    if (!seen.has(live)) {
      seen.add(live);
      out.push(live);
    }
  }
  return out;
}
