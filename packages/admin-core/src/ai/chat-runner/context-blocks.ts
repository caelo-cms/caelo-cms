// SPDX-License-Identifier: MPL-2.0

/**
 * Assembles the pre-catalogue system-prompt context blocks by orchestrating
 * the per-area builders in `./context/*`. Extracted from the pre-split
 * `chat-runner.ts`; this is the "context-block injection" concern (the
 * formatters themselves live in the sibling `../system-prompt.ts`, which this
 * module calls but does not modify).
 *
 * It does NOT call `composeSystemPromptChunks` or build the tool catalogue —
 * those run in `index.ts`, because the subagents / plugins / plugin-context
 * blocks depend on the already-filtered catalogue (see
 * `buildPostCatalogueBlocks`).
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ChatEngagement, ChatSendMessageInput, ExecutionContext } from "@caelo-cms/shared";

import { buildCatalogBlocks } from "./context/catalog.js";
import { buildDomainBlocks } from "./context/domains.js";
import { buildForeignLocksBlock } from "./context/foreign-locks.js";
import { buildAllPagesBlock, buildPageContext } from "./context/page.js";
import { buildSiteBlocks } from "./context/site.js";
import { buildSkillsContext } from "./context/skills.js";

/** The pre-catalogue blocks passed (alongside the post-catalogue blocks) to composeSystemPromptChunks. */
export interface PreCatalogueBlocks {
  chipsBlock: string | undefined;
  pageContextBlock: string | undefined;
  allPagesBlock: string | undefined;
  siteIdentityBlock: string | undefined;
  designSystemBlock: string | undefined;
  themeBlock: string | undefined;
  structuredSetsBlock: string | undefined;
  modulesBlock: string | undefined;
  contentLibraryBlock: string | undefined;
  layoutsBlock: string | undefined;
  siteDefaultsBlock: string | undefined;
  mediaBlock: string | undefined;
  redirectsBlock: string | undefined;
  localesBlock: string | undefined;
  pendingProposalsBlock: string | undefined;
  /** issue #262 — entities locked by OTHER chats (interim guard until #264 leases). */
  foreignLocksBlock: string | undefined;
  usersBlock: string | undefined;
  rolesBlock: string | undefined;
  aiProvidersBlock: string | undefined;
  domainsBlock: string | undefined;
  skillsBlock: string | undefined;
}

export interface SystemContextResult {
  preBlocks: PreCatalogueBlocks;
  /** Raw op values fed to buildToolDescribeState. */
  layoutsValue: unknown;
  templatesValue: unknown;
  siteDefaultsValue: unknown;
  /** Skill engagement results consumed by the tool catalogue + post-catalogue blocks. */
  engagedSkills: ChatEngagement[];
  allowedToolNames: Set<string> | null;
  /**
   * Cold-start status appended to the user message (in-memory only,
   * never persisted). Lists ONLY the base setup still missing ("Theme:
   * needs setup, Layout: needs setup"), each entry naming the tool that
   * fixes it; undefined once the site's foundation is complete, so
   * steady-state turns carry zero status overhead. Kept from the 2026-07
   * prompt-diet experiment: the data chunks won the A/B, but this line
   * measurably stopped cold-start dithering (the AI fixes the named
   * gaps without asking the operator).
   */
  statusLine: string | undefined;
}

/**
 * Derive the cold-start status from state already loaded for
 * buildToolDescribeState (+ one cheap themes.get_active read). Each
 * entry names the tool that fixes it — the AI acts without asking.
 * Exported for unit tests; production callers go through
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
}): Promise<SystemContextResult> {
  const { registry, adapter, humanCtx, humanCtxWithBranch, aiActorId, input } = deps;

  // P5.2 #4 — chips render as a volatile chunk so they don't bust the
  // cache prefix (BASE + memory + tools).
  const chipsBlock =
    input.chips.length > 0
      ? [
          "# Element references in this turn",
          ...input.chips.map((c) => `- ${c.label} (module=${c.moduleId}, selector=${c.selector})`),
        ].join("\n")
      : undefined;

  const { pageContextBlock } = await buildPageContext(
    registry,
    adapter,
    humanCtxWithBranch,
    input.activePageId,
  );
  const allPagesBlock = await buildAllPagesBlock(registry, adapter, humanCtxWithBranch);
  const catalog = await buildCatalogBlocks(registry, adapter, humanCtx, humanCtxWithBranch);
  const site = await buildSiteBlocks(registry, adapter, humanCtxWithBranch);
  const domains = await buildDomainBlocks(registry, adapter, humanCtx, aiActorId);
  // issue #262 — foreign-lock visibility so the AI warns during planning
  // instead of hitting Locked errors mid-run (run #7 regression class).
  const foreignLocksBlock = await buildForeignLocksBlock(
    registry,
    adapter,
    humanCtx,
    input.chatSessionId,
  );
  const skills = await buildSkillsContext(registry, adapter, humanCtx, {
    userMessage: input.content,
    chipCount: input.chips.length,
    chatSessionId: input.chatSessionId,
  });

  // Cold-start status: one cheap active-theme read; everything else
  // reuses the values already loaded for buildToolDescribeState.
  const activeThemeR = await execute(
    registry,
    adapter,
    humanCtxWithBranch,
    "themes.get_active",
    {},
  );
  const activeTheme = activeThemeR.ok
    ? (activeThemeR.value as { theme: { origin?: string | null } | null }).theme
    : null;
  const statusLine = buildStatusLine({
    layoutsValue: site.layoutsValue,
    templatesValue: site.templatesValue,
    siteDefaultsValue: site.siteDefaultsValue,
    activeTheme,
  });

  return {
    preBlocks: {
      chipsBlock,
      pageContextBlock,
      allPagesBlock,
      siteIdentityBlock: site.siteIdentityBlock,
      designSystemBlock: site.designSystemBlock,
      themeBlock: catalog.themeBlock,
      structuredSetsBlock: catalog.structuredSetsBlock,
      modulesBlock: catalog.modulesBlock,
      contentLibraryBlock: catalog.contentLibraryBlock,
      layoutsBlock: site.layoutsBlock,
      siteDefaultsBlock: site.siteDefaultsBlock,
      mediaBlock: catalog.mediaBlock,
      redirectsBlock: domains.redirectsBlock,
      localesBlock: domains.localesBlock,
      pendingProposalsBlock: domains.pendingProposalsBlock,
      foreignLocksBlock,
      usersBlock: domains.usersBlock,
      rolesBlock: domains.rolesBlock,
      aiProvidersBlock: domains.aiProvidersBlock,
      domainsBlock: domains.domainsBlock,
      skillsBlock: skills.skillsBlock,
    },
    layoutsValue: site.layoutsValue,
    templatesValue: site.templatesValue,
    siteDefaultsValue: site.siteDefaultsValue,
    engagedSkills: skills.engagedSkills,
    allowedToolNames: skills.allowedToolNames,
    statusLine,
  };
}
