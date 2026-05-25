// SPDX-License-Identifier: MPL-2.0

/**
 * Typed errors emitted by the theme primitive (#45, v0.11.0).
 *
 * Per CLAUDE.md §11 ("Failure surfaces are AI-actionable") every error
 * includes the next step the AI should try inside `.message`. The ops
 * layer wraps these as `err({kind:"HandlerError", message})`; the AI
 * tool layer returns them in `content`. Inline classes (vs ad-hoc
 * strings) so callers can `instanceof` to surface structured fields
 * (suggestions, available presets) to the UI / system-prompt later.
 */

/**
 * Loose token name could not be normalized to a canonical DTCG path.
 * Carries the closest-match suggestions so the AI's next attempt has
 * a concrete target.
 */
export class UnknownTokenName extends Error {
  readonly input: string;
  readonly suggestions: readonly string[];
  constructor(input: string, suggestions: readonly string[]) {
    const tail =
      suggestions.length > 0
        ? ` — did you mean ${suggestions.map((s) => `'${s}'`).join(" or ")}?`
        : " — pass a canonical DTCG path like 'color.primary' or 'typography.heading.fontFamily'";
    super(`UnknownTokenName: cannot infer canonical path for '${input}'${tail}`);
    this.name = "UnknownTokenName";
    this.input = input;
    this.suggestions = suggestions;
  }
}

/**
 * Value supplied for a color token isn't in a supported CSS color
 * format. The message names every format we accept so the AI's retry
 * lands.
 */
export class InvalidColorValue extends Error {
  readonly input: string;
  readonly supportedFormats: readonly string[] = [
    "#rrggbb",
    "#rgb",
    "oklch(L C H)",
    "oklch(L C H / A)",
    "rgb(R G B)",
    "rgb(R G B / A)",
  ];
  constructor(input: string) {
    super(
      `InvalidColorValue: '${input}' is not a recognised CSS color — supported formats: ${[
        "#rrggbb",
        "#rgb",
        "oklch(L C H)",
        "rgb(R G B)",
      ].join(", ")}. Try a hex like '#3b82f6' or 'oklch(0.6 0.2 250)'.`,
    );
    this.name = "InvalidColorValue";
    this.input = input;
  }
}

/**
 * Preset name passed to create_theme is unknown. Message lists every
 * preset shipped this release.
 */
export class PresetNotFound extends Error {
  readonly input: string;
  readonly available: readonly string[];
  constructor(input: string, available: readonly string[]) {
    super(
      `PresetNotFound: '${input}' is not a known preset — pick one of ${available
        .map((p) => `'${p}'`)
        .join(", ")}.`,
    );
    this.name = "PresetNotFound";
    this.input = input;
    this.available = available;
  }
}

/**
 * Loose-name input resolved to a canonical path but the value's
 * inferred category doesn't match the category for that path
 * (e.g. caller put a `0.5rem` value at `color.primary`).
 */
export class TokenCategoryMismatch extends Error {
  readonly canonicalPath: string;
  readonly expected: string;
  readonly got: string;
  constructor(canonicalPath: string, expected: string, got: string) {
    super(
      `TokenCategoryMismatch: '${canonicalPath}' expects a ${expected} value, got a ${got} — re-send with a value matching ${expected}.`,
    );
    this.name = "TokenCategoryMismatch";
    this.canonicalPath = canonicalPath;
    this.expected = expected;
    this.got = got;
  }
}
