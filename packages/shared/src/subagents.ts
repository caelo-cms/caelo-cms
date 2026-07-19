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
 *       rebuild ({pages[], contentNotes[], skipped[], summary})
 *   - parseSubagentResult — pulls JSON out of the subagent's final
 *     assistant message (handles ```json fences) and validates against
 *     the requested shape.
 */

import { z } from "zod";

const expectedReturnShape = z.enum(["verdict", "tree", "freeform", "rebuild"]);
export type ExpectedReturnShape = z.infer<typeof expectedReturnShape>;

/**
 * Run #8 R2a — the SINGLE source of truth for the return-shape enum.
 *
 * The spawn tools' hand-written provider `inputSchema` (JSON Schema) must
 * carry the same enum values as this Zod schema; in run #8 the live
 * validator rejected `"rebuild"` because the runtime resolved a stale
 * pre-#266 build of this module while the provider schema advertised the
 * new value (issue #251 drift class, resolution flavour). Tool files
 * derive their JSON-Schema enums from this array instead of re-typing the
 * literals, and a unit test asserts the tool schema accepts every shape
 * this parser knows.
 */
export const EXPECTED_RETURN_SHAPES: readonly ExpectedReturnShape[] = expectedReturnShape.options;

/**
 * issue #306 — model tier a subagent runs at. `inherit` (the default) is
 * today's behaviour: the child reuses the parent chat's provider+model.
 * `mid` / `small` route the child onto a cheaper model the Owner mapped
 * in the active provider's config (`ai_providers.config.modelTiers`).
 * The tier VOCABULARY is deliberately abstract — tool results and
 * editor-facing text never name the underlying model (CLAUDE.md §2:
 * provider brand never surfaces in the editor chat UI); concrete model
 * ids appear only on Owner surfaces (security panel, cost dashboard).
 */
export const subagentModelTier = z.enum(["inherit", "mid", "small"]);
export type SubagentModelTier = z.infer<typeof subagentModelTier>;
/** Single source of truth for the tier enum (same #251 drift-guard pattern
 *  as EXPECTED_RETURN_SHAPES — tool JSON schemas derive from this array). */
export const SUBAGENT_MODEL_TIERS: readonly SubagentModelTier[] = subagentModelTier.options;

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
    /**
     * Per-spawn cost cap in microcents. OPTIONAL on purpose (issue #304):
     * when omitted, the spawn orchestrator derives the cap from the armed
     * run budget (#297) or falls back to SUBAGENT_CHILD_CAP_MICROCENTS.
     * The old schema default (50M µ¢ = $0.50) sat BELOW the empirically
     * observed 90–167M µ¢ per-child spend of migration page batches
     * (runs #14/#15), so every child errored at the cap — a default here
     * would make "AI omitted it" indistinguishable from "AI chose $0.50".
     */
    maxCostMicrocents: z.number().int().nonnegative().optional(),
    /**
     * Per-spawn wall-clock timeout. Default 300s (5 min): the documented
     * fan-out use cases are page BUILDS — a Genesis design draft (full page +
     * image generation) and a migration per-type rebuild each legitimately run
     * 2–4 min. The old 60s default aborted every build child mid-work (Genesis
     * live-run 2026-07: all 3 draft children `timed_out` at ~60000ms, so the
     * flow saved 0 drafts; the abort also skips the child's `ai_calls` write, so
     * the roll-up read `$0.00` — the child WAS building, not idle). Quick
     * reviewer children (qa/legal/menu/categorizer) finish well under this
     * ceiling, so the higher default is harmless for them. The AI can still
     * pass a smaller `timeoutMs` for a known-fast child.
     */
    timeoutMs: z.number().int().min(1000).max(600_000).default(300_000),
    /**
     * issue #306 — model tier for this child. Default `inherit` keeps
     * single-model behaviour byte-identical to pre-#306 (conservative
     * default: nothing changes until a caller opts in per-spawn AND the
     * Owner has mapped the tier). A requested-but-unmapped tier is a
     * LOUD structured error at spawn time — never a silent downgrade to
     * the parent's model (CLAUDE.md §2 no-fallbacks).
     */
    tier: subagentModelTier.default("inherit"),
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
    // issue #304 — 32 matches the tool's advertised provider-schema
    // maxItems (SUBAGENT_MAX_BATCH default). The previous max(8) silently
    // rejected the very batches the provider schema invited (#251 drift
    // class): a 14-page migration fan-out failed Zod validation at
    // dispatch and fell back to serial building. SUBAGENT_MAX_BATCH must
    // never be env-raised past this hard bound.
    subagents: z.array(subagentSpec).min(1).max(32),
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

/**
 * issue #264 — compact per-page rebuild summary for migration fan-out
 * subagents. The orchestrator chat's context grows by THIS shape only
 * (never by the subagent's full transcript), so it is deliberately
 * bounded: per-page status + short notes, deliberate omissions with a
 * reason, and a one-paragraph summary. `pageId`/`slug` are both
 * optional because a subagent that failed before resolving a page can
 * still report the slug it was briefed with (or vice versa).
 */
export const rebuildReturnShape = z
  .object({
    pages: z
      .array(
        z
          .object({
            pageId: z.string().uuid().optional(),
            slug: z.string().min(1).max(500).optional(),
            /**
             * issue #306 — `needs_escalation`: the child detected the page
             * needs something it is not equipped to BUILD (no matching
             * module/pattern, a layout decision, unexpected source
             * structure) and hands it back instead of improvising. The
             * orchestrator re-dispatches exactly those pages one capability
             * step up (see subagent-batch.ts escalation waves). The reason
             * lives in `notes` and is REQUIRED for this status — a blind
             * escalation would just re-run the same confusion at higher
             * cost (enforced by the superRefine below).
             */
            status: z.enum(["rebuilt", "skipped", "failed", "needs_escalation"]),
            /** Content-completeness note: what was dropped/merged and why, or
             *  why skipped/failed — or, for `needs_escalation`, the REQUIRED
             *  reason the page needs a more capable pass. */
            notes: z.string().max(2000).optional(),
          })
          .strict()
          .superRefine((page, ctx) => {
            if (page.status === "needs_escalation" && !page.notes?.trim()) {
              ctx.addIssue({
                code: "custom",
                path: ["notes"],
                message:
                  'status "needs_escalation" requires `notes` explaining WHAT new thing this page needs (missing pattern, layout decision, unexpected structure) — the escalated pass is briefed from it',
              });
            }
          }),
      )
      .min(1)
      .max(100),
    /** Cross-page content-completeness observations (e.g. "source pricing table had a footnote row I folded into the caption"). */
    contentNotes: z.array(z.string().min(1).max(2000)).max(50).default([]),
    /** Items deliberately left out — the orchestrator relays these verbatim. */
    skipped: z
      .array(
        z
          .object({
            item: z.string().min(1).max(500),
            reason: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    summary: z.string().max(4000).default(""),
  })
  .strict();
export type RebuildReturn = z.infer<typeof rebuildReturnShape>;

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
  | { ok: true; shape: "freeform"; value: FreeformReturn }
  | { ok: true; shape: "rebuild"; value: RebuildReturn };

export type ParseResult = ParseSuccess | { ok: false; error: string };

/**
 * Run #10 D2 — validate an ALREADY-PARSED value against the requested
 * return shape. This is the structured half of the result channel: the
 * `submit_result` tool hands the payload straight from the tool-call
 * arguments (already JSON — no fence-stripping, no brace-balancing),
 * so the "response is not valid JSON" failure class cannot occur.
 * `parseSubagentResult` (final-text fallback) delegates here after its
 * JSON extraction.
 *
 * For `freeform`, accepts `{text: "..."}` OR a bare string (wrapped as
 * `{text}`) so the model can pass its prose directly.
 */
export function validateSubagentResultValue(
  value: unknown,
  shape: ExpectedReturnShape,
): ParseResult {
  // v0.2.67 — when the schema rejects, include the actual top-level
  // keys the subagent returned so the parent AI can tell whether the
  // subagent ignored the schema entirely (returned freeform text under
  // a different shape) vs. got close but mistyped a single field.
  const observedKeys =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.keys(value as Record<string, unknown>)
      : [];
  const observedSummary =
    observedKeys.length > 0
      ? ` got keys: [${observedKeys.slice(0, 8).join(", ")}]`
      : ` got: ${typeof value} (${Array.isArray(value) ? "array" : "scalar"})`;
  const issueSummary = (issues: readonly z.ZodIssue[]): string =>
    issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");

  if (shape === "freeform") {
    if (typeof value === "string") {
      if (value.trim().length === 0) return { ok: false, error: "subagent returned empty text" };
      return { ok: true, shape: "freeform", value: { text: value.trim() } };
    }
    const validated = freeformReturnShape.safeParse(value);
    if (!validated.success) {
      return {
        ok: false,
        error: `freeform shape mismatch (expected {text: string} or a plain string):${observedSummary}; ${issueSummary(validated.error.issues)}`,
      };
    }
    return { ok: true, shape: "freeform", value: validated.data };
  }
  if (shape === "verdict") {
    const validated = verdictReturnShape.safeParse(value);
    if (!validated.success) {
      return {
        ok: false,
        error: `verdict shape mismatch (expected {pass: boolean, issues: array, suggestions?: array}):${observedSummary}; ${issueSummary(validated.error.issues)}`,
      };
    }
    return { ok: true, shape: "verdict", value: validated.data };
  }
  if (shape === "rebuild") {
    const validated = rebuildReturnShape.safeParse(value);
    if (!validated.success) {
      return {
        ok: false,
        error: `rebuild shape mismatch (expected {pages: [{pageId?, slug?, status: "rebuilt"|"skipped"|"failed"|"needs_escalation", notes?}], contentNotes?: string[], skipped?: [{item, reason}], summary?: string}):${observedSummary}; ${issueSummary(validated.error.issues)}`,
      };
    }
    return { ok: true, shape: "rebuild", value: validated.data };
  }
  // tree
  const validated = treeReturnShape.safeParse(value);
  if (!validated.success) {
    return {
      ok: false,
      error: `tree shape mismatch (expected {tree: array, rationale?: string}):${observedSummary}; ${issueSummary(validated.error.issues)}`,
    };
  }
  return { ok: true, shape: "tree", value: validated.data };
}

/**
 * Pull JSON out of the subagent's final assistant text and validate
 * against the requested shape. On schema mismatch, returns
 * `{ok: false, error}` so the caller can decide whether to retry.
 *
 * For `freeform`, accepts EITHER `{text: "..."}` JSON or raw text;
 * raw text is wrapped as `{text: rawText}` so the caller always gets
 * the same shape.
 *
 * Run #10 D2 — this is now the FALLBACK channel; the canonical path is
 * the child calling `submit_result`, whose payload is validated by
 * `validateSubagentResultValue` without any text extraction.
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
  return validateSubagentResultValue(parsed, shape);
}
