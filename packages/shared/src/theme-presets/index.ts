// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.0 — Theme preset loader (#45, follow-up comment §2).
 *
 * Four DTCG-shaped presets ship as JSON next to this loader. The AI's
 * `propose_create_theme` tool accepts a preset name + brand overrides;
 * the server expands the preset, applies overrides, and validates the
 * result through `themes.ts`'s Zod schema.
 *
 * Presets are treated as code (SPDX-headered, contrast-tested, PR-
 * reviewed) — a bad preset breaks every install that bootstraps from
 * it. Adding a new preset means: (a) drop a `<name>.json` here, (b) add
 * it to `PRESET_NAMES` below, (c) extend the contrast test.
 */

import { PresetNotFound } from "../themes-errors.js";
import { type ThemeDocument, validateThemeTokens } from "../themes.js";
import minimalJson from "./minimal.json" with { type: "json" };
import playfulJson from "./playful.json" with { type: "json" };
import shadcnDefaultJson from "./shadcn-default.json" with { type: "json" };
import warmJson from "./warm.json" with { type: "json" };

export const PRESET_NAMES = ["shadcn-default", "minimal", "warm", "playful"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

const PRESETS: Record<PresetName, unknown> = {
  "shadcn-default": shadcnDefaultJson,
  minimal: minimalJson,
  warm: warmJson,
  playful: playfulJson,
};

/**
 * Return a validated copy of the named preset. Throws `PresetNotFound`
 * with the list of available presets on unknown names — the message
 * the AI sees is concrete enough to retry with a valid name.
 *
 * The returned object is a fresh clone so callers can mutate (e.g.
 * apply overrides) without poisoning the cached JSON.
 */
export function getPreset(name: string): ThemeDocument {
  if (!isPresetName(name)) {
    throw new PresetNotFound(name, PRESET_NAMES);
  }
  const raw = PRESETS[name];
  // Clone before validating so caller mutations don't leak across calls.
  const cloned = JSON.parse(JSON.stringify(raw));
  return validateThemeTokens(cloned);
}

function isPresetName(name: string): name is PresetName {
  return (PRESET_NAMES as readonly string[]).includes(name);
}
