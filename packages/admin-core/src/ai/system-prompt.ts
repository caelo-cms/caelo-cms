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

/**
 * v0.10.20 — Build the `## Structured-data sets you can edit` block from
 * the `structured_sets.list` result. Extracted from chat-runner.ts so
 * the formatter is unit-testable without spinning up a chat session.
 *
 * v0.10.21 — Always emits the **concept primer**, even when no sets
 * exist on this install. Pre-v0.10.21 this returned `undefined` on an
 * empty list, so the AI didn't know structured-data sets existed as a
 * concept and fell back to editing the header module's HTML directly
 * when asked to "update the navigation."
 *
 * v0.10.22 — primer rewritten to reference the unified CRUD surface
 * (`list_structured_sets` / `get_structured_set` / `set_structured_set`
 * / `delete_structured_set`). The kind-specific wrappers `set_nav_menu`
 * and `update_theme` were removed; the AI uses `kind` as a discriminator
 * argument and the per-kind JSON Schema on `set_structured_set`
 * enforces the right item shape at the tool-call boundary.
 *
 * For `kind === "nav-menu"` (and only that kind), inline each item as
 * `{ label, href[, target, children: N] }` so the AI can copy-modify
 * without a `structured_sets.get` round-trip. Other kinds carry
 * larger / less-frequently-edited shapes and stay summarized to
 * bound the prompt size. Cap nav-menu inlining at 30 items per menu;
 * outliers fall back to count-only.
 */
export function formatStructuredSetsBlock(
  sets: readonly { kind: string; slug: string; displayName: string; items: unknown }[],
): string {
  const primer = [
    "# Structured-data sets you can edit",
    "Caelo has typed named lists for **global repeated content**: navigation menus, tags, taxonomies, theme tokens, link-lists, and language-selectors. When the user asks about any of these, prefer creating or editing a structured set over hardcoding values in module HTML — that's what these lists are for.",
    "",
    "Kinds: `nav-menu`, `tags`, `taxonomy`, `theme`, `link-list`, `language-selector`. Item shape is per-kind and enforced by the JSON Schema on `set_structured_set` (a mismatch is rejected at the tool boundary with a structured error).",
    "",
    "Tools (one unified CRUD surface — `kind` is a discriminator argument):",
    "- `list_structured_sets({ kind? })` — list sets; omit `kind` for all. Existing sets are already inlined below at session start; call this only after writes or if the listing was truncated.",
    "- `get_structured_set({ kind, slug })` — fetch one set's items. Use before a partial update (e.g. tweak one theme token) so you can merge in JS.",
    "- `set_structured_set({ kind, slug, displayName, items })` — UPSERT. Creates the set when the slug doesn't exist; REPLACES `items` if it does (NOT append — pass the full desired list).",
    "- `delete_structured_set({ kind, slug })` — remove a set.",
    "",
    "Renderer convention: a module with slug `<kind>-<slug>` auto-renders the matching `<kind>/<slug>` set. Currently only `nav-menu-<slug>` and `language-selector-<slug>` auto-wire — for the other kinds, the rendering module's HTML/JS references the items directly via the structured-sets API. To wire a brand-new nav menu onto a layout: (1) `set_structured_set({ kind: 'nav-menu', slug: 'X', displayName: '…', items: [...] })` to create the items, (2) ensure a module named `nav-menu-X` is on the layout's header (or footer) block — use `add_module_to_layout` if it doesn't exist yet.",
    "",
    'If the user mentions "navigation", "the nav", "the menu", "header links", "footer menu" — that\'s a nav-menu, NOT a module to edit. Reach for `set_structured_set` with `kind: "nav-menu"` first.',
    "",
    "Theme-token tweaks ('brighten the primary color', 'use Inter for headings') are a `theme/site` structured set. For partial updates, call `get_structured_set` first, mutate in JS, then `set_structured_set` with the merged array — DON'T overwrite the whole token list with just the changed tokens.",
  ].join("\n");
  if (sets.length === 0) {
    return [
      primer,
      "",
      "_No sets exist yet on this install — create one with the tool above._",
    ].join("\n");
  }
  return [
    primer,
    "",
    "Existing sets on this install:",
    ...sets.map((s) => {
      const items = Array.isArray(s.items) ? (s.items as unknown[]) : [];
      const header = `- ${s.kind}/${s.slug} ("${s.displayName}") — ${items.length} item${items.length === 1 ? "" : "s"}`;
      if (s.kind !== "nav-menu" || items.length === 0 || items.length > 30) {
        return header;
      }
      const lines = (
        items as Array<{
          label?: unknown;
          href?: unknown;
          target?: unknown;
          children?: unknown;
        }>
      ).map((it, i) => {
        const label = typeof it.label === "string" ? it.label : "?";
        const href = typeof it.href === "string" ? it.href : "?";
        const target = it.target ? `, target: "${String(it.target)}"` : "";
        const kids =
          Array.isArray(it.children) && it.children.length > 0
            ? `, children: ${it.children.length}`
            : "";
        return `    ${i + 1}. { label: ${JSON.stringify(label)}, href: ${JSON.stringify(href)}${target}${kids} }`;
      });
      return `${header}:\n${lines.join("\n")}`;
    }),
  ].join("\n");
}

// SystemPromptChunk is defined in ./provider.ts so adapters can import
// it without pulling in the system-prompt composer; we re-use that type here.
import type { SystemPromptChunk } from "./provider.js";

export type { SystemPromptChunk } from "./provider.js";

// v0.5.10 — tightened "describe before calling" → "briefly state, then
// call". The old phrasing combined with the STAGING_BLOCK anti-pattern
// invited the model to describe extensively and skip the tool calls.
const BASE_SYSTEM = [
  "You are Caelo, an AI co-editor for a content management system.",
  "Editors describe what they want changed; you respond conversationally and use tools",
  "to make the changes. Briefly state what you're about to do (one sentence), then call",
  "the tools that do it. Never call tools other than the ones listed below.",
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
// v0.5.9 — rewritten to lead with action over description.
// v0.5.10 — trimmed: dropped redundant clauses already covered by the
// lead; cut from 13 lines to 7. Tighter prompts give the model fewer
// instructions to misread.
const STAGING_BLOCK = [
  "## Staging",
  "",
  "When the user asks for changes, **make them via the tools below first.** Every write lands in this chat's branch — invisible to the live site until the user clicks Stage.",
  "",
  "Tell the user what you did + that the Stage button in /edit ships it to staging. Don't claim a change is live.",
  "",
  "The user has a split-button `[Stage | ▾]` in the /edit overlay. Clicking Stage merges every branched edit into main and rebuilds staging in one shot (the staging URL is a 1:1 preview of what production would see). The `▾` dropdown gates production publish with per-kind checkboxes. You don't drive either — propose, then narrate.",
  "",
  "**Anti-pattern: describing what you would do without calling tools.** If the user asks you to build, edit, or create something, your response MUST include the tool calls that do the work. Text saying 'I will do X' without an actual tool call is wrong — make X happen via the tools, then explain what you did.",
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
