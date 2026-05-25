// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.1 (issue #76) — theme import format auto-detection chain.
 *
 * Tries each importer in priority order:
 *
 *   1. DTCG (most specific: `$value` leaves)
 *   2. Style Dictionary (`value` leaves)
 *   3. Tailwind 4 (`@theme { … }` block)
 *   4. shadcn (`:root { … }` CSS variables)
 *   5. Loose key-value (`{looseName: value}` JSON object)
 *
 * The first importer that doesn't throw a "shape" rejection wins.
 * "Hard" parse errors (e.g. TailwindImportError for calc()) surface
 * verbatim — they signal the input WAS that format but unparseable.
 *
 * Returns `{format, tokens}` so the caller's tool result can echo the
 * detected format back to the AI for next-turn awareness.
 */

import type { ThemeDocument } from "../themes.js";
import {
  NoImporterMatched,
  NotDtcgShape,
  NotLooseShape,
  NotShadcnShape,
  NotStyleDictionaryShape,
  NotTailwindShape,
} from "../themes-errors.js";
import { importDtcg } from "./dtcg.js";
import { importLoose } from "./loose.js";
import { importShadcn } from "./shadcn.js";
import { importStyleDictionary } from "./style-dictionary.js";
import { importTailwind } from "./tailwind.js";

export type DetectedFormat = "dtcg" | "style-dictionary" | "tailwind" | "shadcn" | "loose";

export interface AutoDetectResult {
  readonly format: DetectedFormat;
  readonly tokens: ThemeDocument;
}

interface ImporterDef {
  readonly format: DetectedFormat;
  readonly importer: (body: string) => ThemeDocument;
  /** When true, the auto-detect chain falls through on this error class. */
  readonly fallThroughOn: ReadonlyArray<new (...args: never[]) => Error>;
}

const CHAIN: readonly ImporterDef[] = [
  { format: "dtcg", importer: importDtcg, fallThroughOn: [NotDtcgShape] },
  {
    format: "style-dictionary",
    importer: importStyleDictionary,
    fallThroughOn: [NotStyleDictionaryShape],
  },
  { format: "tailwind", importer: importTailwind, fallThroughOn: [NotTailwindShape] },
  { format: "shadcn", importer: importShadcn, fallThroughOn: [NotShadcnShape] },
  { format: "loose", importer: importLoose, fallThroughOn: [NotLooseShape] },
];

export function autoDetectAndImport(body: string): AutoDetectResult {
  const attempts: Array<{ format: string; reason: string }> = [];
  for (const def of CHAIN) {
    try {
      const tokens = def.importer(body);
      return { format: def.format, tokens };
    } catch (e) {
      const isFallThrough = def.fallThroughOn.some((cls) => e instanceof cls);
      if (!isFallThrough) {
        // Hard error: the input WAS in this format but the importer
        // can't handle it. Surface verbatim so the operator/AI gets a
        // concrete fix-it.
        throw e;
      }
      attempts.push({
        format: def.format,
        reason: e instanceof Error ? e.message.split("\n")[0] ?? "rejected" : "rejected",
      });
    }
  }
  throw new NoImporterMatched(attempts);
}
