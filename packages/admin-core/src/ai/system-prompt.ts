// SPDX-License-Identifier: MPL-2.0

/**
 * Composes the system prompt sent to the AI provider on every chat
 * call. Pulls Owner-curated `site_ai_memory` slots, orders them
 * deterministically (so prompt-cache hits accumulate across calls),
 * and appends a brief tool catalogue.
 *
 * Returns ordered chunks (P5.2 #4) so adapters that support prompt-
 * cache can mark the long-lived chunks (`base`, `memory`, `tools`)
 * cacheable while leaving short-lived chunks (per-turn chips,
 * engaged-skill bodies) outside the cache. `composeSystemPromptString`
 * concatenates for callers that don't care about the structure.
 */

const SLOT_ORDER = [
  "purpose",
  "brand-voice",
  "tone",
  "banned-phrases",
  "instructions",
  "glossary",
] as const;

const SLOT_HEADINGS: Record<(typeof SLOT_ORDER)[number], string> = {
  purpose: "Purpose",
  "brand-voice": "Brand voice",
  tone: "Tone",
  "banned-phrases": "Banned phrases",
  instructions: "Recurring instructions",
  glossary: "Glossary",
};

export interface MemoryRow {
  readonly slot: string;
  readonly body: string;
}

export interface ToolCatalogueEntry {
  readonly name: string;
  readonly description: string;
}

// SystemPromptChunk is defined in ./provider.ts so adapters can import
// it without pulling in the system-prompt composer; we re-use that type here.
import type { SystemPromptChunk } from "./provider.js";

export type { SystemPromptChunk } from "./provider.js";

const BASE_SYSTEM = [
  "You are Caelo, an AI co-editor for a content management system.",
  "Editors describe what they want changed; you respond conversationally and use tools",
  "to make the changes. Always describe what you are doing and why before calling a tool.",
  "Never call tools other than the ones listed below.",
].join(" ");

// v0.4.0 — module model. Tells the AI when to use edit_module
// (structural / global) vs set_page_module_content (per-page content).
// Cacheable since it's stable across every call.
//
// v0.5.1+ — module edits are now CHAT-BRANCHED until publish (same as
// content). See `## Staging` block below for the full three-state flow.
const MODULE_MODEL_BLOCK = [
  "## Module model",
  "",
  "Caelo separates STRUCTURE from CONTENT:",
  "",
  "- A **module** is reusable code (HTML template + CSS + JS) plus a declared **field schema** (an array of named slots).",
  "  Module HTML references slots as `{{fieldName}}`. When you change module code it affects every page that uses the module,",
  "  but the change is branched to this chat until publish (same as content).",
  "- **Page content** is the per-placement values that fill those slots (e.g. the actual headline text on /home's hero).",
  "  Content is PAGE-BOUND and branched to this chat until publish.",
  "",
  "Tool selection:",
  "",
  "- Use `edit_module` to change structure / styling / layout / the list of fields a module exposes.",
  "  → Affects every page using the module, branched to this chat until publish.",
  "- Use `set_page_module_content` to change what a specific placement on a specific page shows in its fields.",
  "  → Page-bound, branched to this chat until publish.",
  "",
  'When the operator says "change the hero text on /home" → set_page_module_content.',
  'When the operator says "the hero looks ugly, redesign it" → edit_module.',
  "When in doubt: structural / cross-page → edit_module; content / per-page → set_page_module_content.",
].join("\n");

// v0.5.5 — staging model. Every chat write is "pending" until the user
// stages + publishes it. Cacheable — applies to every chat session.
//
// v0.5.9 — rewritten. The previous shape led with "Do NOT claim a change
// is live" + a verbatim example response ("I've drafted the change ...").
// In production this tipped the model into passivity: on build requests
// the AI would emit a short text response describing what it WOULD do
// without calling any tools, then end its turn. New shape leads with
// "make the change via tools first" and adds an explicit anti-pattern
// callout so the model knows describing-without-doing is wrong.
const STAGING_BLOCK = [
  "## Staging",
  "",
  "When the user asks for changes, **make them via the tools below first.**",
  "Every write you make in this chat lands as `pending` — saved in this chat's branch, NOT visible on the live site until the user stages and publishes via the chat panel's Stage / Publish button.",
  "",
  "After making the changes, tell the user what you did and that they can click Stage then Publish to ship it.",
  "Don't claim a change is live — staging is the step before publishing.",
  "",
  "You may call `stage_change` to mark an individual edit as ready (helpful when you've done several edits and only some are ready to ship now).",
  "You may call `unstage_change` to demote a staged edit back to pending.",
  "There is no `publish_staged` tool — Publish is the user's button by design.",
  "",
  "**Anti-pattern: describing what you would do without calling tools.** If the user asks you to build, edit, or create something, your response MUST include the tool calls that do the work. A text-only response saying 'I will do X' is wrong — make X happen via the tools, then explain what you did.",
].join("\n");

/**
 * Optional per-call volatile context: chips, ephemeral skill bodies,
 * the active /edit page's modules + blocks. Anything that changes
 * turn-to-turn goes here so the cache prefix stays stable.
 */
export interface VolatileContext {
  readonly chipsBlock?: string;
  readonly pageContextBlock?: string;
  /** P6.7.5 — full site page list, so AI can pick real link targets. */
  readonly allPagesBlock?: string;
  /** P6.7.5 — current theme tokens (CSS variables). */
  readonly themeBlock?: string;
  /** P6.7.5 — named structured-data sets the AI can edit (nav-menu, tags, etc.). */
  readonly structuredSetsBlock?: string;
  /** P6.7.6 — available layouts + their blocks (chrome shells). */
  readonly layoutsBlock?: string;
  /** P6.7.6 — site_defaults singleton + per-template layout binding. */
  readonly siteDefaultsBlock?: string;
  /** P7 — recent + most-used media so the AI can pick existing assets. */
  readonly mediaBlock?: string;
  /** P8 AI-first — recent redirects so the AI can plan + cite without round-trip. */
  readonly redirectsBlock?: string;
  /** P9 — locales registry + AI's own pending locale-change proposals. */
  readonly localesBlock?: string;
  /** v0.2.32 — cross-domain `## Pending proposals` block. Aggregates
   *  every status='pending' row across the 15 *_pending tables so the
   *  AI doesn't re-queue what the Owner is already reviewing. */
  readonly pendingProposalsBlock?: string;
  /** v0.2.38 — `## Users` inventory (email + roleNames per row). */
  readonly usersBlock?: string;
  /** v0.2.38 — `## Roles` inventory (name + permission count + builtin). */
  readonly rolesBlock?: string;
  /** v0.2.38 — `## AI providers` inventory (active + has-key per row). */
  readonly aiProvidersBlock?: string;
  /** v0.2.38 — `## Domains` inventory (hostname + kind + TLS status). */
  readonly domainsBlock?: string;
  /** P10A — engaged skills' bodies, tagged with slug + source. */
  readonly skillsBlock?: string;
  /** P10.5 #5 — hint that spawn_subagent / spawn_subagents exist + when to use them. */
  readonly subagentsBlock?: string;
  /** P11 opt 4 — AI's own pending or rejected plugin submissions, so it
   *  doesn't re-propose what's already in the queue and reads the
   *  Owner's rejection reasons before resubmitting. */
  readonly pluginsBlock?: string;
  /** P11.5 audit fix #1 — Tier-1 plugin-emitted system-prompt blocks.
   *  Plugins declare `promptContext: [{label, render}]` arrays; chat-runner
   *  calls renderAll() per turn and folds non-empty results here. Disabled
   *  plugins are skipped at the registry level. */
  readonly pluginContextBlock?: string;
}

export function composeSystemPromptChunks(
  memory: readonly MemoryRow[],
  tools: readonly ToolCatalogueEntry[],
  volatile: VolatileContext = {},
): SystemPromptChunk[] {
  const chunks: SystemPromptChunk[] = [
    { body: BASE_SYSTEM, cacheable: true, label: "base" },
    { body: MODULE_MODEL_BLOCK, cacheable: true, label: "module-model" },
    { body: STAGING_BLOCK, cacheable: true, label: "staging" },
  ];

  const bySlot = new Map(memory.map((m) => [m.slot, m.body.trim()]));
  const memoryLines: string[] = [];
  for (const slot of SLOT_ORDER) {
    const body = bySlot.get(slot);
    if (!body) continue;
    memoryLines.push(`## ${SLOT_HEADINGS[slot]}\n${body}`);
  }
  if (memoryLines.length > 0) {
    chunks.push({
      body: ["# Site memory", ...memoryLines].join("\n\n"),
      cacheable: true,
      label: "memory",
    });
  }

  if (tools.length > 0) {
    const toolLines = tools.map((t) => `- **${t.name}** — ${t.description}`);
    chunks.push({
      body: ["# Available tools", ...toolLines].join("\n"),
      cacheable: true,
      label: "tools",
    });
  }

  // Volatile chunks go last so the cache prefix above stays byte-stable.
  if (volatile.skillsBlock && volatile.skillsBlock.trim().length > 0) {
    chunks.push({ body: volatile.skillsBlock, cacheable: false, label: "skills" });
  }
  if (volatile.subagentsBlock && volatile.subagentsBlock.trim().length > 0) {
    chunks.push({ body: volatile.subagentsBlock, cacheable: false, label: "subagents" });
  }
  if (volatile.pluginsBlock && volatile.pluginsBlock.trim().length > 0) {
    chunks.push({ body: volatile.pluginsBlock, cacheable: false, label: "plugins" });
  }
  if (volatile.pluginContextBlock && volatile.pluginContextBlock.trim().length > 0) {
    chunks.push({
      body: volatile.pluginContextBlock,
      cacheable: false,
      label: "plugin-context",
    });
  }
  if (volatile.themeBlock && volatile.themeBlock.trim().length > 0) {
    chunks.push({ body: volatile.themeBlock, cacheable: false, label: "theme" });
  }
  if (volatile.allPagesBlock && volatile.allPagesBlock.trim().length > 0) {
    chunks.push({ body: volatile.allPagesBlock, cacheable: false, label: "all-pages" });
  }
  if (volatile.structuredSetsBlock && volatile.structuredSetsBlock.trim().length > 0) {
    chunks.push({ body: volatile.structuredSetsBlock, cacheable: false, label: "structured-sets" });
  }
  if (volatile.layoutsBlock && volatile.layoutsBlock.trim().length > 0) {
    chunks.push({ body: volatile.layoutsBlock, cacheable: false, label: "layouts" });
  }
  if (volatile.siteDefaultsBlock && volatile.siteDefaultsBlock.trim().length > 0) {
    chunks.push({ body: volatile.siteDefaultsBlock, cacheable: false, label: "site-defaults" });
  }
  if (volatile.mediaBlock && volatile.mediaBlock.trim().length > 0) {
    chunks.push({ body: volatile.mediaBlock, cacheable: false, label: "media" });
  }
  if (volatile.redirectsBlock && volatile.redirectsBlock.trim().length > 0) {
    chunks.push({ body: volatile.redirectsBlock, cacheable: false, label: "redirects" });
  }
  if (volatile.localesBlock && volatile.localesBlock.trim().length > 0) {
    chunks.push({ body: volatile.localesBlock, cacheable: false, label: "locales" });
  }
  if (volatile.pendingProposalsBlock && volatile.pendingProposalsBlock.trim().length > 0) {
    chunks.push({
      body: volatile.pendingProposalsBlock,
      cacheable: false,
      label: "pending_proposals",
    });
  }
  if (volatile.usersBlock && volatile.usersBlock.trim().length > 0) {
    chunks.push({ body: volatile.usersBlock, cacheable: false, label: "users" });
  }
  if (volatile.rolesBlock && volatile.rolesBlock.trim().length > 0) {
    chunks.push({ body: volatile.rolesBlock, cacheable: false, label: "roles" });
  }
  if (volatile.aiProvidersBlock && volatile.aiProvidersBlock.trim().length > 0) {
    chunks.push({ body: volatile.aiProvidersBlock, cacheable: false, label: "ai_providers" });
  }
  if (volatile.domainsBlock && volatile.domainsBlock.trim().length > 0) {
    chunks.push({ body: volatile.domainsBlock, cacheable: false, label: "domains" });
  }
  if (volatile.pageContextBlock && volatile.pageContextBlock.trim().length > 0) {
    chunks.push({ body: volatile.pageContextBlock, cacheable: false, label: "page-context" });
  }
  if (volatile.chipsBlock && volatile.chipsBlock.trim().length > 0) {
    chunks.push({ body: volatile.chipsBlock, cacheable: false, label: "chips" });
  }

  return chunks;
}

/** Backwards-compatible flat-string composer. */
export function composeSystemPrompt(
  memory: readonly MemoryRow[],
  tools: readonly ToolCatalogueEntry[],
): string {
  return composeSystemPromptChunks(memory, tools)
    .map((c) => c.body)
    .join("\n\n");
}
