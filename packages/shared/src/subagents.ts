// SPDX-License-Identifier: MPL-2.0

/**
 * P10.5 — Subagent invocation shapes (Zod) + result parser.
 *
 * A subagent is just a chat-runner turn. The `spawn_subagent` AI tool
 * lets the parent kick off another chat-runner turn with a constrained
 * tool set + a seed task message; the matcher inside that turn engages
 * whichever skill the task wording matches. Same chat-runner code path,
 * different inputs.
 *
 * This file holds:
 *   - subagentSpec — single-spawn input shape.
 *   - spawnSubagentToolInput — wraps one spec.
 *   - spawnSubagentsToolInput — wraps an array (parallel batch).
 *   - Return-shape variants the AI can request:
 *       verdict ({pass, issues[], suggestions[]})
 *       tree    ({tree: [...], rationale})
 *       freeform ({text})
 *   - parseSubagentResult — pulls JSON out of the subagent's final
 *     assistant message (handles ```json fences) and validates against
 *     the requested shape.
 */

import { z } from "zod";

const expectedReturnShape = z.enum(["verdict", "tree", "freeform"]);
export type ExpectedReturnShape = z.infer<typeof expectedReturnShape>;

/**
 * One subagent spec. The parent supplies role + task + optional
 * narrowing. The handler creates the ephemeral chat session, appends
 * the task as the seed user message, calls runChatTurn directly with
 * `excludedToolNames=spawn_subagent,spawn_subagents` (depth cap) +
 * `allowedToolNames` from the spec.
 */
export const subagentSpec = z
  .object({
    /** Owner-readable role label for the verdicts UI + the subagent_runs row. */
    role: z.string().min(1).max(120),
    /** The seed user message. The matcher engages skills based on this text. */
    task: z.string().min(1).max(8000),
    /**
     * Optional tool-catalogue narrowing. When omitted, the subagent
     * gets the default registry MINUS the spawn tools. When set, the
     * subagent gets the INTERSECTION of (default minus spawn) and
     * `allowedToolNames` — typically read-only ops for safety.
     */
    allowedToolNames: z.array(z.string().min(1).max(120)).optional(),
    /** Zod-validated return shape. Defaults to `verdict`. */
    expectedReturnShape: expectedReturnShape.default("verdict"),
    /** Per-spawn cost cap; default 50_000_000 microcents = $0.50. */
    maxCostMicrocents: z.number().int().nonnegative().default(50_000_000),
    /** Per-spawn timeout; default 60s. */
    timeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
    /**
     * Optional active page id. When passed, the spawn handler routes
     * it through to the runChatTurn invocation as `activePageId`,
     * giving the subagent the same Current-page volatile chunk a
     * normal /edit chat would see. The subagent still has to call
     * `pages.get_with_modules` to pull module HTML.
     */
    activePageId: z.string().uuid().optional(),
  })
  .strict();
export type SubagentSpec = z.infer<typeof subagentSpec>;

export const spawnSubagentToolInput = subagentSpec;
export type SpawnSubagentToolInput = SubagentSpec;

export const spawnSubagentsToolInput = z
  .object({
    subagents: z.array(subagentSpec).min(1).max(8),
  })
  .strict();
export type SpawnSubagentsToolInput = z.infer<typeof spawnSubagentsToolInput>;

// ---------------------------------------------------------------------
// Return-shape variants the parent asks the subagent to emit
// ---------------------------------------------------------------------

export const verdictReturnShape = z
  .object({
    pass: z.boolean(),
    issues: z
      .array(z.union([z.string().min(1).max(2000), z.record(z.string(), z.unknown())]))
      .max(50),
    suggestions: z.array(z.string().min(1).max(2000)).max(50).default([]),
  })
  .strict();
export type VerdictReturn = z.infer<typeof verdictReturnShape>;

export const treeReturnShape = z
  .object({
    tree: z.array(z.unknown()).max(500),
    rationale: z.string().max(4000).default(""),
  })
  .strict();
export type TreeReturn = z.infer<typeof treeReturnShape>;

export const freeformReturnShape = z
  .object({
    text: z.string().min(1).max(40_000),
  })
  .strict();
export type FreeformReturn = z.infer<typeof freeformReturnShape>;

// ---------------------------------------------------------------------
// Result parser — handles `````json {…} ````` fences + raw JSON.
// ---------------------------------------------------------------------

function stripFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    const firstNl = trimmed.indexOf("\n");
    const last = trimmed.lastIndexOf("```");
    if (firstNl !== -1 && last > firstNl) {
      return trimmed.slice(firstNl + 1, last).trim();
    }
  }
  // Common case: raw JSON wrapped in prose. Pull out the first {...}
  // block by brace-balancing. If no braces, return as-is.
  const firstBrace = trimmed.indexOf("{");
  if (firstBrace === -1) return trimmed;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = firstBrace; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inStr) {
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return trimmed.slice(firstBrace, i + 1);
    }
  }
  return trimmed;
}

export type ParseSuccess =
  | { ok: true; shape: "verdict"; value: VerdictReturn }
  | { ok: true; shape: "tree"; value: TreeReturn }
  | { ok: true; shape: "freeform"; value: FreeformReturn };

export type ParseResult = ParseSuccess | { ok: false; error: string };

/**
 * Pull JSON out of the subagent's final assistant text and validate
 * against the requested shape. On schema mismatch, returns
 * `{ok: false, error}` so the caller can decide whether to retry.
 *
 * For `freeform`, accepts EITHER `{text: "..."}` JSON or raw text;
 * raw text is wrapped as `{text: rawText}` so the caller always gets
 * the same shape.
 */
export function parseSubagentResult(text: string, shape: ExpectedReturnShape): ParseResult {
  if (shape === "freeform") {
    // Try JSON first; on failure treat the whole thing as freeform text.
    try {
      const stripped = stripFences(text);
      const parsed = JSON.parse(stripped) as unknown;
      const validated = freeformReturnShape.safeParse(parsed);
      if (validated.success) return { ok: true, shape: "freeform", value: validated.data };
    } catch {
      /* fall through */
    }
    if (text.trim().length === 0) return { ok: false, error: "subagent returned empty text" };
    return { ok: true, shape: "freeform", value: { text: text.trim() } };
  }

  const stripped = stripFences(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    return {
      ok: false,
      error: `subagent response is not valid JSON: ${(e as Error).message}; first 200 chars: ${stripped.slice(0, 200)}`,
    };
  }
  // v0.2.67 — when the schema rejects, include the actual top-level
  // keys the subagent returned so the parent AI can tell whether the
  // subagent ignored the schema entirely (returned freeform text under
  // a different shape) vs. got close but mistyped a single field.
  const observedKeys =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? Object.keys(parsed as Record<string, unknown>)
      : [];
  const observedSummary =
    observedKeys.length > 0
      ? ` got keys: [${observedKeys.slice(0, 8).join(", ")}]`
      : ` got: ${typeof parsed} (${Array.isArray(parsed) ? "array" : "scalar"})`;
  if (shape === "verdict") {
    const validated = verdictReturnShape.safeParse(parsed);
    if (!validated.success) {
      return {
        ok: false,
        error: `verdict shape mismatch (expected {pass: boolean, issues: array, suggestions?: array}):${observedSummary}; ${validated.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ")}`,
      };
    }
    return { ok: true, shape: "verdict", value: validated.data };
  }
  // tree
  const validated = treeReturnShape.safeParse(parsed);
  if (!validated.success) {
    return {
      ok: false,
      error: `tree shape mismatch (expected {tree: array, rationale?: string}):${observedSummary}; ${validated.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    };
  }
  return { ok: true, shape: "tree", value: validated.data };
}
