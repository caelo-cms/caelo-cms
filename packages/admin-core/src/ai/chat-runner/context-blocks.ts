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
  /**
   * One line naming the plugins that are installed but NOT running.
   *
   * An inactive plugin is absent from everything else the AI can see —
   * no tools, no skills, no ops. Without this line the AI could not
   * tell "this site cannot do translations" from "this site has a
   * translation plugin nobody switched on", and would quietly improvise
   * with core tools instead of offering the one click that fixes it.
   * Undefined when every installed plugin is active.
   */
  installedPluginsBlock: string | undefined;
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
   * Skills activated after this chat began. Deliberately absent from the
   * pinned index; announced once on the USER message instead.
   */
  newlyActivatedSkills: ReadonlyArray<{ slug: string; description: string }>;
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
  /** `site_defaults.get_seo` result; null when the read failed. */
  seoValue?: unknown;
  activeTheme: { origin?: string | null; description?: string | null } | null;
}): string | undefined {
  const missing: string[] = [];
  const layouts = (args.layoutsValue as { layouts?: unknown[] } | null)?.layouts ?? [];
  const templates = (args.templatesValue as { templates?: unknown[] } | null)?.templates ?? [];
  const defaults =
    (
      args.siteDefaultsValue as {
        defaults?: { siteName?: string | null; siteLanguage?: string | null } | null;
      } | null
    )?.defaults ?? null;
  if (layouts.length === 0) missing.push("Layout: needs setup (create_layout)");
  if (templates.length === 0) missing.push("Template: needs setup (create_template)");
  if (!defaults) missing.push("Site defaults: needs setup (set_site_defaults)");
  else if (!defaults.siteName)
    missing.push(
      "Site identity: not captured (set_site_identity — do this FIRST, from the user's own words)",
    );
  // Migration 0232 — no `en` default; publishing fails until it is set.
  // Strictly null: an absent field (failed or partial read) is not evidence.
  if (defaults && defaults.siteLanguage === null)
    missing.push(
      "Site language: not set — publishing fails until it is (set_site_identity({siteLanguage}) with the BCP 47 tag of the language the operator writes in or wants the copy in, e.g. 'de'; for a migration, the source site's Lang:)",
    );
  // #551 — Owner-only setting (site_defaults.set_seo), so the entry names
  // where the operator sets it rather than a tool.
  const seo = args.seoValue as { siteBaseUrl?: string | null } | null | undefined;
  if (seo && seo.siteBaseUrl === null) {
    missing.push(
      "Site URL: not configured — publishing fails until the Owner sets the public site address at /security/seo (you cannot set it; tell the operator before they publish)",
    );
  }
  if (!args.activeTheme || (args.activeTheme.origin ?? "seed") === "seed") {
    missing.push(
      "Theme: needs setup — active theme is a gray SEED; compose a full brand palette via set_theme_tokens + set_theme_meta BEFORE authoring visitor-facing pages",
    );
  }
  if (missing.length === 0) return undefined;
  return `[Site status — base setup still missing] ${missing.join(" | ")}`;
}

/**
 * Name the installed-but-inactive plugins, and nothing else about them.
 *
 * Deliberately terse: this is a pointer, not a catalogue. The AI reaches
 * for `list_plugins` when it actually needs detail, which keeps the
 * cached prefix small and stops the block from turning into a second
 * tool listing.
 */
async function buildInstalledPluginsBlock(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  humanCtx: ExecutionContext,
): Promise<string | undefined> {
  const r = await execute(registry, adapter, humanCtx, "plugins.list", {});
  if (!r.ok) return undefined;
  const rows = (r.value as { plugins: { slug: string; status: string }[] }).plugins;
  const dormant = rows
    .filter((p) => p.status === "awaiting_activation" || p.status === "disabled")
    .map((p) => p.slug)
    .sort();
  if (dormant.length === 0) return undefined;
  return [
    "# Installed plugins (not running)",
    `These plugins are installed on this site but NOT active, so none of their tools or skills exist for you right now: ${dormant.join(", ")}.`,
    "If the operator asks for something one of them would provide, say so and tell them it takes one click at /security/plugins — do NOT improvise the capability with core tools, and do NOT claim the site cannot do it. Call list_plugins if you need their exact status.",
  ].join("\n");
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
  /** When this chat session was created. Pins the `## Skills` index to
   *  the skills that were active then, so a mid-chat activation can't
   *  rewrite the cached system prefix. */
  chatStartedAt?: string | null;
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
    chatStartedAt: deps.chatStartedAt ?? null,
  });
  const installedPluginsBlock = await buildInstalledPluginsBlock(registry, adapter, humanCtx);

  // Cold-start status: the ONLY site-state reads that remain, and only to name
  // what base setup is still missing (cheap counts; the line is undefined — no
  // reads matter — once the foundation exists). Fetched here rather than dumped
  // as prompt blocks; the line itself rides on the user message.
  const [layoutsR, templatesR, defaultsR, themeR, seoR] = await Promise.all([
    execute(registry, adapter, humanCtxWithBranch, "layouts.list", { includeDeleted: false }),
    execute(registry, adapter, humanCtxWithBranch, "templates.list", { includeDeleted: false }),
    execute(registry, adapter, humanCtxWithBranch, "site_defaults.get", {}),
    execute(registry, adapter, humanCtxWithBranch, "themes.get_active", {}),
    execute(registry, adapter, humanCtxWithBranch, "site_defaults.get_seo", {}),
  ]);
  const statusLine = buildStatusLine({
    layoutsValue: layoutsR.ok ? layoutsR.value : null,
    templatesValue: templatesR.ok ? templatesR.value : null,
    siteDefaultsValue: defaultsR.ok ? defaultsR.value : null,
    seoValue: seoR.ok ? seoR.value : null,
    activeTheme: themeR.ok
      ? (themeR.value as { theme: { origin?: string | null } | null }).theme
      : null,
  });

  return {
    preBlocks: { skillsIndexBlock: skills.skillsIndexBlock, installedPluginsBlock },
    pageContextBlock,
    engagedSkills: skills.engagedSkills,
    allowedToolNames: skills.allowedToolNames,
    newlyActivatedSkills: skills.newlyActivated,
    statusLine,
  };
}
