// SPDX-License-Identifier: MPL-2.0

/**
 * issue #306 — pure tier→model mapping logic for multi-model routing.
 *
 * The Owner maps abstract tiers onto concrete model ids in the ACTIVE
 * provider row's config (`ai_providers.config.modelTiers`, jsonb — same
 * home as `model` / `maxOutputTokens`, no schema migration needed):
 *
 *   { "modelTiers": { "mid": "<model-id>", "small": "<model-id>" } }
 *
 * The presence of that key IS the per-install enablement switch: with no
 * mapping configured, every spawn that requests a non-inherit tier fails
 * LOUDLY (CLAUDE.md §2 — no silent downgrade to the parent's model), and
 * specs that don't request a tier behave exactly as before #306.
 *
 * Everything here is side-effect free (no DB, no env) so the resolution
 * rules are unit-testable in isolation; provider-resolver.ts owns the
 * DB read and the AIProvider construction.
 *
 * Brand rule: the error strings below flow back to the (editor-facing)
 * parent AI as tool results, so they name TIERS, never model ids —
 * concrete models stay on Owner surfaces (CLAUDE.md §2).
 */

import type { SubagentModelTier } from "@caelo-cms/shared";

/** The Owner-configured tier→model-id mapping (validated shape). */
export interface ModelTierMap {
  readonly mid?: string;
  readonly small?: string;
}

/** Result shape shared by the parse + resolve helpers below. */
export type ModelTierResult<T> = { ok: true; value: T } | { ok: false; error: string };

const MAPPABLE_TIERS = ["mid", "small"] as const;

/**
 * Validate the raw `config.modelTiers` value from the active provider row.
 *
 *   - `undefined` / `null` → `{ok, value: null}` — tiering NOT enabled on
 *     this install (the conservative default).
 *   - a well-formed object → the validated map (unknown keys rejected so a
 *     typo like `"smal"` fails loudly instead of silently not matching).
 *   - anything else → a loud structured error naming exactly what to fix.
 */
export function parseModelTierMap(raw: unknown): ModelTierResult<ModelTierMap | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      error:
        'ai_providers.config.modelTiers is malformed: expected an object like {"mid": "<model-id>", "small": "<model-id>"}, got ' +
        `${Array.isArray(raw) ? "an array" : typeof raw}. Fix the active provider's config at /security/ai.`,
    };
  }
  const record = raw as Record<string, unknown>;
  const map: { mid?: string; small?: string } = {};
  for (const key of Object.keys(record)) {
    if (!(MAPPABLE_TIERS as readonly string[]).includes(key)) {
      return {
        ok: false,
        error:
          `ai_providers.config.modelTiers has an unknown tier key ${JSON.stringify(key)} — ` +
          `only ${MAPPABLE_TIERS.map((t) => JSON.stringify(t)).join(" and ")} are mappable ` +
          '("inherit" is implicit and never mapped). Fix the config at /security/ai.',
      };
    }
    const value = record[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      return {
        ok: false,
        error:
          `ai_providers.config.modelTiers.${key} must be a non-empty model-id string, got ` +
          `${typeof value}. Fix the config at /security/ai.`,
      };
    }
    map[key as (typeof MAPPABLE_TIERS)[number]] = value.trim();
  }
  // {} configured explicitly = mapping present but empty. Treat as
  // not-enabled (there is nothing to route to) rather than a distinct
  // half-state.
  if (map.mid === undefined && map.small === undefined) return { ok: true, value: null };
  return { ok: true, value: map };
}

/**
 * Resolve one requested tier against the (parsed) mapping.
 *
 *   - `inherit` → `{ok, value: null}` — caller uses the parent's provider.
 *   - mapped tier → the model id to run the child on.
 *   - unmapped / tiering-disabled → a LOUD error with both recoveries
 *     spelled out (CLAUDE.md §11: failure surfaces are AI-actionable).
 */
export function resolveTierModel(
  tier: SubagentModelTier,
  tiers: ModelTierMap | null,
): ModelTierResult<string | null> {
  if (tier === "inherit") return { ok: true, value: null };
  if (tiers === null) {
    return {
      ok: false,
      error:
        `model tier "${tier}" was requested but this install has no model tiers configured — ` +
        "tiering is opt-in and currently OFF. Recovery: (1) re-issue the same spawn WITHOUT the " +
        "`tier` field to run at this chat's model, or (2) the Owner maps tiers on the active " +
        "provider at /security/ai (config key `modelTiers`). Do not claim the subagents ran.",
    };
  }
  const model = tiers[tier];
  if (model === undefined) {
    return {
      ok: false,
      error:
        `model tier "${tier}" is not mapped on this install (configured tiers: ` +
        `${MAPPABLE_TIERS.filter((t) => tiers[t] !== undefined)
          .map((t) => JSON.stringify(t))
          .join(", ")}). Recovery: (1) re-issue the spawn WITHOUT the \`tier\` field, or use a ` +
        "configured tier; (2) the Owner adds the mapping at /security/ai (config key " +
        "`modelTiers`). Do not claim the subagents ran.",
    };
  }
  return { ok: true, value: model };
}

/** Tiers (beyond `inherit`) that a mapping makes dispatchable. */
export function availableMappedTiers(tiers: ModelTierMap | null): ReadonlySet<string> {
  const set = new Set<string>();
  if (tiers?.mid !== undefined) set.add("mid");
  if (tiers?.small !== undefined) set.add("small");
  return set;
}
