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
import type { ChatEngagement, ChatSendMessageInput, ExecutionContext } from "@caelo-cms/shared";

import type { ToolDescribeStateActivePage } from "../tools/describe-state.js";
import { buildCatalogBlocks } from "./context/catalog.js";
import { buildDomainBlocks } from "./context/domains.js";
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
  usersBlock: string | undefined;
  rolesBlock: string | undefined;
  aiProvidersBlock: string | undefined;
  domainsBlock: string | undefined;
  skillsBlock: string | undefined;
}

export interface SystemContextResult {
  preBlocks: PreCatalogueBlocks;
  /** Captured for the per-page blockName enum in buildToolDescribeState (issue #106). */
  activePageForState: ToolDescribeStateActivePage | null;
  /** Raw op values fed to buildToolDescribeState. */
  layoutsValue: unknown;
  templatesValue: unknown;
  siteDefaultsValue: unknown;
  /** Skill engagement results consumed by the tool catalogue + post-catalogue blocks. */
  engagedSkills: ChatEngagement[];
  allowedToolNames: Set<string> | null;
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

  const { pageContextBlock, activePageForState } = await buildPageContext(
    registry,
    adapter,
    humanCtxWithBranch,
    input.activePageId,
  );
  const allPagesBlock = await buildAllPagesBlock(registry, adapter, humanCtxWithBranch);
  const catalog = await buildCatalogBlocks(registry, adapter, humanCtx, humanCtxWithBranch);
  const site = await buildSiteBlocks(registry, adapter, humanCtxWithBranch);
  const domains = await buildDomainBlocks(registry, adapter, humanCtx, aiActorId);
  const skills = await buildSkillsContext(registry, adapter, humanCtx, {
    userMessage: input.content,
    chipCount: input.chips.length,
    chatSessionId: input.chatSessionId,
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
      usersBlock: domains.usersBlock,
      rolesBlock: domains.rolesBlock,
      aiProvidersBlock: domains.aiProvidersBlock,
      domainsBlock: domains.domainsBlock,
      skillsBlock: skills.skillsBlock,
    },
    activePageForState,
    layoutsValue: site.layoutsValue,
    templatesValue: site.templatesValue,
    siteDefaultsValue: site.siteDefaultsValue,
    engagedSkills: skills.engagedSkills,
    allowedToolNames: skills.allowedToolNames,
  };
}
