// SPDX-License-Identifier: MPL-2.0

/**
 * issue #300 part A — per-turn context-split telemetry. Estimates where
 * the ~103K base input tokens of a fresh call actually go: system
 * prompt, per-label `##` context blocks, per-slug skill bodies, the
 * tool catalogue (prompt listing + JSON schemas), and provider history.
 *
 * Everything is a chars/4 ESTIMATE (the same heuristic compaction.ts
 * uses), labelled as such in the emitted object — the point is a
 * stable, comparable breakdown across runs so every future context
 * diet (skill phase-scoping, block capping, catalogue trimming) is
 * measurable, not exact provider-side accounting.
 *
 * Pure: consumes the already-composed system chunks + filtered tool
 * catalogue + provider history; never re-fetches or re-renders. The
 * chat-runner logs one `[chat-runner] context-split` line per turn
 * (loop 0 payload) from `index.ts`.
 */

import type { ChatMessageInput, SystemPromptChunk, ToolDefinition } from "../provider.js";
import { estimateHistoryTokens, estimateTextTokens } from "./compaction.js";

/**
 * Chunk labels that make up the fixed prose backbone of the system
 * prompt (identity + module model + staging rules + Owner-curated
 * memory). Everything else labelled is either the tool catalogue, the
 * skills block, or a domain context block.
 */
const CORE_PROMPT_LABELS: ReadonlySet<string> = new Set([
  "base",
  "module-model",
  "staging",
  "memory",
]);

/** The chunk label carrying the in-prompt `# Available tools` listing. */
const TOOLS_CHUNK_LABEL = "tools";

/** The chunk label carrying the concatenated engaged-skill bodies. */
const SKILLS_CHUNK_LABEL = "skills";

/**
 * Matches the per-skill section headers `buildSkillsContext` emits:
 * `## Skill: <slug> (<source>[ — rationale])`. Captures the slug.
 */
const SKILL_SECTION_HEADER = /^## Skill: (\S+) \(/;

/** Key for skills-chunk chars not attributable to one skill (the `# Engaged skills` preamble). */
const SKILLS_SHARED_KEY = "(shared)";

export interface ContextSplitEstimate {
  /** Heuristic marker so log readers never mistake this for provider-exact counts. */
  readonly estimator: "chars/4";
  /** Sum of every component below — the loop-0 input-token estimate (excl. provider framing overhead). */
  readonly totalTokens: number;
  /** Fixed prose backbone: base + module-model + staging + memory chunks. */
  readonly systemPromptTokens: number;
  /** `# Available tools` prompt chunk + the JSON schemas sent as the provider `tools` param. */
  readonly toolCatalogueTokens: number;
  /** Per-label estimate for every other system-prompt chunk (theme, modules, all-pages, …). */
  readonly contextBlockTokens: Readonly<Record<string, number>>;
  /** Per-slug estimate for each engaged skill's body (from the skills chunk sections). */
  readonly skillTokens: Readonly<Record<string, number>>;
  /** Provider message history (loop-0 shape), via the compaction estimator. */
  readonly historyTokens: number;
  readonly historyMessages: number;
}

/**
 * Split the concatenated skills chunk into per-slug char counts.
 * Chars before the first `## Skill:` header (the `# Engaged skills`
 * preamble) land under {@link SKILLS_SHARED_KEY}. Exported for direct
 * fixture-string testing.
 */
export function splitSkillsBlockChars(body: string): Record<string, number> {
  const out: Record<string, number> = {};
  const lines = body.split("\n");
  let currentKey = SKILLS_SHARED_KEY;
  let currentChars = 0;
  const flush = (): void => {
    if (currentChars > 0) out[currentKey] = (out[currentKey] ?? 0) + currentChars;
  };
  for (const line of lines) {
    const m = SKILL_SECTION_HEADER.exec(line);
    if (m?.[1]) {
      flush();
      currentKey = m[1];
      currentChars = 0;
    }
    // +1 for the newline each line contributes (the final line's extra
    // newline is a 1-char rounding artifact, irrelevant at chars/4).
    currentChars += line.length + 1;
  }
  flush();
  return out;
}

/**
 * Build the per-turn context-split estimate. `systemChunks` accepts the
 * legacy flat-string form (all attributed to systemPromptTokens) as
 * well as the labelled chunk list.
 */
export function buildContextSplitEstimate(args: {
  systemChunks: string | readonly SystemPromptChunk[];
  providerTools: readonly ToolDefinition[];
  messages: readonly ChatMessageInput[];
}): ContextSplitEstimate {
  let systemPromptTokens = 0;
  let toolCatalogueTokens = 0;
  const contextBlockTokens: Record<string, number> = {};
  const skillTokens: Record<string, number> = {};

  if (typeof args.systemChunks === "string") {
    systemPromptTokens = estimateTextTokens(args.systemChunks);
  } else {
    for (const chunk of args.systemChunks) {
      if (CORE_PROMPT_LABELS.has(chunk.label)) {
        systemPromptTokens += estimateTextTokens(chunk.body);
      } else if (chunk.label === TOOLS_CHUNK_LABEL) {
        toolCatalogueTokens += estimateTextTokens(chunk.body);
      } else if (chunk.label === SKILLS_CHUNK_LABEL) {
        for (const [slug, chars] of Object.entries(splitSkillsBlockChars(chunk.body))) {
          skillTokens[slug] = (skillTokens[slug] ?? 0) + Math.ceil(chars / 4);
        }
      } else {
        contextBlockTokens[chunk.label] =
          (contextBlockTokens[chunk.label] ?? 0) + estimateTextTokens(chunk.body);
      }
    }
  }

  // The provider `tools` param carries full JSON schemas per tool —
  // typically several times larger than the in-prompt name+description
  // listing; both are catalogue cost.
  if (args.providerTools.length > 0) {
    toolCatalogueTokens += estimateTextTokens(JSON.stringify(args.providerTools));
  }

  const historyTokens = estimateHistoryTokens(args.messages);
  const totalTokens =
    systemPromptTokens +
    toolCatalogueTokens +
    Object.values(contextBlockTokens).reduce((a, b) => a + b, 0) +
    Object.values(skillTokens).reduce((a, b) => a + b, 0) +
    historyTokens;

  return {
    estimator: "chars/4",
    totalTokens,
    systemPromptTokens,
    toolCatalogueTokens,
    contextBlockTokens,
    skillTokens,
    historyTokens,
    historyMessages: args.messages.length,
  };
}
