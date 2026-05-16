// SPDX-License-Identifier: MPL-2.0

/**
 * v0.6.0 W1 — state passed to a tool's optional `describe(state)` callback
 * so the description rendered into the per-turn provider call reflects
 * LIVE state instead of a static prose string.
 *
 * Why this exists: tool descriptions like "layoutId optional" are lies
 * on a fresh install where site_defaults is empty — the op rejects
 * because there's nothing to fall back to. With state-aware describe(),
 * the same tool reads `state.siteDefaults === null` and emits
 * "layoutId REQUIRED on this site (no defaults configured)". The AI sees
 * the truth at decision time, not a stale general-purpose blurb.
 *
 * Cost shape: zero extra DB cost. The chat-runner already fetches
 * layouts / templates / site_defaults per turn for the system-prompt
 * `# Layouts` / `# Site defaults` blocks; the builder reuses those
 * results. ToolDescribeState is a shallow projection of data already
 * in memory.
 *
 * Tools without `describe()` keep their static `description: string`
 * unchanged — fully backward-compatible.
 */

import type { ExecutionContext } from "@caelo-cms/shared";

export interface ToolDescribeStateLayout {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly blocks: readonly {
    readonly name: string;
    readonly displayName: string;
    /** v0.6.0 alpha.2 — block ordering. Some describe() callbacks
     * surface blocks in render order rather than insertion order. */
    readonly position: number;
  }[];
}

export interface ToolDescribeStateTemplate {
  readonly id: string;
  readonly slug: string;
  readonly layoutId: string;
}

export interface ToolDescribeStateSiteDefaults {
  readonly defaultLayoutSlug: string;
  readonly defaultTemplateSlug: string;
}

/**
 * Snapshot of live site state available to a tool's describe() callback.
 * Built once per chat-runner turn from the same queries that feed the
 * `# Layouts` / `# Templates` / `# Site defaults` system-prompt blocks.
 *
 * Pre-1.0 invariant (CLAUDE.md §2): when a list could not be fetched
 * (op failed), the corresponding field is an empty array — NOT a
 * synthetic fallback. The describe() callback can detect "no data
 * fetched yet" by checking `state.fetchedAt === null` and emit a
 * conservative description rather than asserting "no layouts exist".
 */
export interface ToolDescribeState {
  readonly actor: Pick<ExecutionContext, "actorId" | "actorKind">;
  readonly layouts: readonly ToolDescribeStateLayout[];
  readonly templates: readonly ToolDescribeStateTemplate[];
  readonly siteDefaults: ToolDescribeStateSiteDefaults | null;
  /** Unix ms when the state was assembled; null if assembly was skipped
   * (op failure on every fetch). describe() callbacks should treat null
   * as "unknown state, fall back to static description shape". */
  readonly fetchedAt: number | null;
}

/**
 * Build the state object from results the chat-runner already has in hand.
 * Pass the un-narrowed Query API result values; the builder unwraps the
 * known shapes and tolerates missing fields by emitting empty arrays.
 *
 * The chat-runner already runs the layouts.list / templates.list /
 * site_defaults.get queries for the prose system-prompt blocks. This
 * builder takes those `value` payloads and projects them into the
 * read-only state shape. If any query failed, pass `null` for that
 * slot — the builder is robust to mixed availability.
 */
export function buildToolDescribeState(args: {
  readonly actor: Pick<ExecutionContext, "actorId" | "actorKind">;
  readonly layoutsValue: unknown | null;
  readonly templatesValue: unknown | null;
  readonly siteDefaultsValue: unknown | null;
}): ToolDescribeState {
  const layouts = extractLayouts(args.layoutsValue);
  const templates = extractTemplates(args.templatesValue);
  const siteDefaults = extractSiteDefaults(args.siteDefaultsValue);

  const anyFetched =
    args.layoutsValue !== null ||
    args.templatesValue !== null ||
    args.siteDefaultsValue !== null;

  return {
    actor: args.actor,
    layouts,
    templates,
    siteDefaults,
    fetchedAt: anyFetched ? Date.now() : null,
  };
}

function extractLayouts(value: unknown): ToolDescribeStateLayout[] {
  if (!value || typeof value !== "object") return [];
  const arr = (value as { layouts?: unknown }).layouts;
  if (!Array.isArray(arr)) return [];
  return arr.flatMap((r): ToolDescribeStateLayout[] => {
    if (!r || typeof r !== "object") return [];
    const o = r as {
      id?: unknown;
      slug?: unknown;
      displayName?: unknown;
      blocks?: unknown;
    };
    if (typeof o.id !== "string" || typeof o.slug !== "string") return [];
    const blocks = Array.isArray(o.blocks)
      ? o.blocks.flatMap(
          (b, idx): { name: string; displayName: string; position: number }[] => {
            if (!b || typeof b !== "object") return [];
            const bo = b as { name?: unknown; displayName?: unknown; position?: unknown };
            if (typeof bo.name !== "string") return [];
            return [
              {
                name: bo.name,
                displayName: typeof bo.displayName === "string" ? bo.displayName : bo.name,
                position: typeof bo.position === "number" ? bo.position : idx,
              },
            ];
          },
        )
      : [];
    return [
      {
        id: o.id,
        slug: o.slug,
        displayName: typeof o.displayName === "string" ? o.displayName : o.slug,
        blocks,
      },
    ];
  });
}

function extractTemplates(value: unknown): ToolDescribeStateTemplate[] {
  if (!value || typeof value !== "object") return [];
  const arr = (value as { templates?: unknown }).templates;
  if (!Array.isArray(arr)) return [];
  return arr.flatMap((r): ToolDescribeStateTemplate[] => {
    if (!r || typeof r !== "object") return [];
    const o = r as { id?: unknown; slug?: unknown; layoutId?: unknown };
    if (typeof o.id !== "string" || typeof o.slug !== "string" || typeof o.layoutId !== "string") {
      return [];
    }
    return [{ id: o.id, slug: o.slug, layoutId: o.layoutId }];
  });
}

function extractSiteDefaults(value: unknown): ToolDescribeStateSiteDefaults | null {
  if (!value || typeof value !== "object") return null;
  const inner = (value as { defaults?: unknown }).defaults;
  if (!inner || typeof inner !== "object") return null;
  const o = inner as { defaultLayoutSlug?: unknown; defaultTemplateSlug?: unknown };
  if (typeof o.defaultLayoutSlug !== "string" || typeof o.defaultTemplateSlug !== "string") {
    return null;
  }
  return {
    defaultLayoutSlug: o.defaultLayoutSlug,
    defaultTemplateSlug: o.defaultTemplateSlug,
  };
}
