// SPDX-License-Identifier: MPL-2.0

/**
 * Assembles the (now minimal) pre-catalogue context. The system prompt is 100%
 * STATIC (operator's rule: nothing dynamic in the system prompt, so it stays
 * cached and is never busted), so the only block it still contributes is the
 * static `## Skills` index. Everything the AI once received as a volatile
 * system-prompt block (pages, modules, theme, structured sets, content library,
 * layouts, redirects, locales, users/roles, …) is gone — the AI fetches that
 * state on-demand via the list_/get_ tools (results land in the append-only,
 * cache-friendly message history).
 *
 * Two things ride on the USER message instead (fresh at injection, never in the
 * cached prefix): the current-page context and the cold-start status line —
 * both injected on the first turn and again only when they change (see the
 * chat-runner turn assembly).
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ChatEngagement, ChatSendMessageInput, ExecutionContext } from "@caelo-cms/shared";

import { buildPageContext } from "./context/page.js";
import { buildSkillsContext } from "./context/skills.js";

/** The (static) blocks passed to composeSystemPromptChunks. */
export interface PreCatalogueBlocks {
  /** Static `## Skills` index (slug + description per active skill). */
  skillsIndexBlock: string | undefined;
}

export interface SystemContextResult {
  preBlocks: PreCatalogueBlocks;
  /**
   * Current-page context ("where am I"). Rides on the USER message (first turn
   * + when the page changed), never the system prompt.
   */
  pageContextBlock: string | undefined;
  /** Skills loaded this chat — feeds the tool-catalogue preload + diagnostics. */
  engagedSkills: ChatEngagement[];
  allowedToolNames: Set<string> | null;
  /**
   * Cold-start status ("Theme: needs setup", …), each entry naming the tool
   * that fixes it. Rides on the USER message (first + on change); undefined once
   * the site's foundation is complete.
   */
  statusLine: string | undefined;
}

/**
 * Derive the cold-start status. Each entry names the tool that fixes it — the
 * AI acts without asking. Exported for unit tests; production callers go through
 * buildSystemContextBlocks.
 */
export function buildStatusLine(args: {
  layoutsValue: unknown;
  templatesValue: unknown;
  siteDefaultsValue: unknown;
  activeTheme: { origin?: string | null; description?: string | null } | null;
}): string | undefined {
  const missing: string[] = [];
  const layouts = (args.layoutsValue as { layouts?: unknown[] } | null)?.layouts ?? [];
  const templates = (args.templatesValue as { templates?: unknown[] } | null)?.templates ?? [];
  const defaults =
    (args.siteDefaultsValue as { defaults?: { siteName?: string | null } | null } | null)
      ?.defaults ?? null;
  if (layouts.length === 0) missing.push("Layout: needs setup (create_layout)");
  if (templates.length === 0) missing.push("Template: needs setup (create_template)");
  if (!defaults) missing.push("Site defaults: needs setup (set_site_defaults)");
  else if (!defaults.siteName)
    missing.push(
      "Site identity: not captured (set_site_identity — do this FIRST, from the user's own words)",
    );
  if (!args.activeTheme || (args.activeTheme.origin ?? "seed") === "seed") {
    missing.push(
      "Theme: needs setup — active theme is a gray SEED; compose a full brand palette via set_theme_tokens + set_theme_meta BEFORE authoring visitor-facing pages",
    );
  }
  if (missing.length === 0) return undefined;
  return `[Site status — base setup still missing] ${missing.join(" | ")}`;
}

export async function buildSystemContextBlocks(deps: {
  registry: OperationRegistry;
  adapter: DatabaseAdapter;
  humanCtx: ExecutionContext;
  humanCtxWithBranch: ExecutionContext;
  aiActorId: string;
  input: ChatSendMessageInput;
  /** Slugs the model already loaded this chat (parsed from prior load_skill
   *  tool calls in the history) — drives the skills tool preload. */
  loadedSkillSlugs: readonly string[];
}): Promise<SystemContextResult> {
  const { registry, adapter, humanCtx, humanCtxWithBranch, input } = deps;

  // Current-page context (for the user message) + the static skills index.
  const { pageContextBlock } = await buildPageContext(
    registry,
    adapter,
    humanCtxWithBranch,
    input.activePageId,
  );
  const skills = await buildSkillsContext(registry, adapter, humanCtx, {
    loadedSkillSlugs: deps.loadedSkillSlugs,
  });

  // Cold-start status: the ONLY site-state reads that remain, and only to name
  // what base setup is still missing (cheap counts; the line is undefined — no
  // reads matter — once the foundation exists). Fetched here rather than dumped
  // as prompt blocks; the line itself rides on the user message.
  const [layoutsR, templatesR, defaultsR, themeR] = await Promise.all([
    execute(registry, adapter, humanCtxWithBranch, "layouts.list", { includeDeleted: false }),
    execute(registry, adapter, humanCtxWithBranch, "templates.list", { includeDeleted: false }),
    execute(registry, adapter, humanCtxWithBranch, "site_defaults.get", {}),
    execute(registry, adapter, humanCtxWithBranch, "themes.get_active", {}),
  ]);
  const statusLine = buildStatusLine({
    layoutsValue: layoutsR.ok ? layoutsR.value : null,
    templatesValue: templatesR.ok ? templatesR.value : null,
    siteDefaultsValue: defaultsR.ok ? defaultsR.value : null,
    activeTheme: themeR.ok
      ? (themeR.value as { theme: { origin?: string | null } | null }).theme
      : null,
  });

  return {
    preBlocks: { skillsIndexBlock: skills.skillsIndexBlock },
    pageContextBlock,
    engagedSkills: skills.engagedSkills,
    allowedToolNames: skills.allowedToolNames,
    statusLine,
  };
}
