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

/**
 * Optional per-call volatile context: chips, ephemeral skill bodies,
 * the active /edit page's modules + blocks. Anything that changes
 * turn-to-turn goes here so the cache prefix stays stable.
 */
export interface VolatileContext {
  readonly chipsBlock?: string;
  readonly skillsBlock?: string;
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
}

export function composeSystemPromptChunks(
  memory: readonly MemoryRow[],
  tools: readonly ToolCatalogueEntry[],
  volatile: VolatileContext = {},
): SystemPromptChunk[] {
  const chunks: SystemPromptChunk[] = [{ body: BASE_SYSTEM, cacheable: true, label: "base" }];

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
