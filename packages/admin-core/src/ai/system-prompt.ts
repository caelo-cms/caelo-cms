// SPDX-License-Identifier: MPL-2.0

/**
 * Composes the system prompt sent to the AI provider on every chat
 * call. Pulls Owner-curated `site_ai_memory` slots, orders them
 * deterministically (so prompt-cache hits accumulate across calls),
 * and appends a brief tool catalogue.
 */

const SLOT_ORDER = ["brand-voice", "tone", "banned-phrases", "instructions", "glossary"] as const;

const SLOT_HEADINGS: Record<(typeof SLOT_ORDER)[number], string> = {
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

const BASE_SYSTEM = [
  "You are Caelo, an AI co-editor for a content management system.",
  "Editors describe what they want changed; you respond conversationally and use tools",
  "to make the changes. Always describe what you are doing and why before calling a tool.",
  "Never call tools other than the ones listed below.",
].join(" ");

export function composeSystemPrompt(
  memory: readonly MemoryRow[],
  tools: readonly ToolCatalogueEntry[],
): string {
  const sections: string[] = [BASE_SYSTEM];

  // Memory in fixed slot order so prompt-cache breakpoints land on a
  // stable byte sequence between calls. Empty slots are skipped.
  const bySlot = new Map(memory.map((m) => [m.slot, m.body.trim()]));
  const memoryLines: string[] = [];
  for (const slot of SLOT_ORDER) {
    const body = bySlot.get(slot);
    if (!body) continue;
    memoryLines.push(`## ${SLOT_HEADINGS[slot]}\n${body}`);
  }
  if (memoryLines.length > 0) {
    sections.push(["# Site memory", ...memoryLines].join("\n\n"));
  }

  // Tool catalogue mirrors the provider tool list 1:1; the model gets
  // schemas separately via the provider tools field, so we just remind
  // it of the names + purposes here.
  if (tools.length > 0) {
    const toolLines = tools.map((t) => `- **${t.name}** — ${t.description}`);
    sections.push(["# Available tools", ...toolLines].join("\n"));
  }

  return sections.join("\n\n");
}
