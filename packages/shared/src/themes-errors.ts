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
 * v0.11.0 (#45 opt §2) — `themes.import_dtcg` was handed a JSON body
 * whose shape doesn't look like DTCG (no `$value` anywhere in the
 * tree). v0.11.1 (issue #76) — auto-detect chain uses this as a
 * "fall through to next importer" signal; only surfaces verbatim when
 * the caller explicitly picked the DTCG importer.
 */
export class NotDtcgShape extends Error {
  constructor(message?: string) {
    super(
      message ??
        "NotDtcgShape: the JSON body parsed cleanly but doesn't look like a DTCG document " +
          "(no `$value` keys anywhere in the tree). Send a DTCG-shaped document — see " +
          "https://www.designtokens.org/tr/drafts/format/ for the spec.",
    );
    this.name = "NotDtcgShape";
  }
}

/**
 * v0.11.1 (issue #76) — Style Dictionary importer rejected input.
 * Used as a fall-through signal by the auto-detect chain.
 */
export class NotStyleDictionaryShape extends Error {
  constructor(message?: string) {
    super(
      message ??
        "NotStyleDictionaryShape: input has no nested `{ value: … }` leaves typical of " +
          "Style Dictionary v3/v4. Looks like another format — try DTCG ($value leaves), " +
          "Tailwind 4 (@theme block), or shadcn (:root CSS variables).",
    );
    this.name = "NotStyleDictionaryShape";
  }
}

/**
 * v0.11.1 (issue #76) — Tailwind 4 `@theme { … }` importer rejected
 * input. Either no `@theme` block found, or the body contained a
 * construct the line-by-line parser can't handle (calc(), nested
 * at-rules). Auto-detect chain catches it and falls through.
 */
export class NotTailwindShape extends Error {
  constructor(message?: string) {
    super(
      message ??
        "NotTailwindShape: input has no `@theme { … }` block. Send the contents of your " +
          "Tailwind 4 theme file or use a different importer.",
    );
    this.name = "NotTailwindShape";
  }
}

/**
 * v0.11.1 (issue #76) — Tailwind 4 importer hit a construct it can't
 * parse (e.g. `calc(…)` values, nested at-rules). Surfaced verbatim
 * by the auto-detect chain since the input WAS Tailwind-shaped — the
 * caller should simplify or pre-resolve.
 */
export class TailwindImportError extends Error {
  readonly construct: string;
  constructor(construct: string, line: string) {
    super(
      `TailwindImportError: the @theme block contains '${construct}' which the importer can't parse: '${line.trim()}'. ` +
        "Pre-resolve calc()/var() to literal values, or split nested at-rules into a separate file.",
    );
    this.name = "TailwindImportError";
    this.construct = construct;
  }
}

/**
 * v0.11.1 (issue #76) — shadcn `:root { … }` importer rejected input
 * (no `:root` selector found, or values were wrapped in `{value: …}`
 * style-dictionary shape). Auto-detect chain falls through.
 */
export class NotShadcnShape extends Error {
  constructor(message?: string) {
    super(
      message ??
        "NotShadcnShape: input has no `:root { … }` CSS block with `--<name>: <value>;` pairs. " +
          "Send a shadcn-style CSS variable list (with optional `.dark { … }` for dark mode).",
    );
    this.name = "NotShadcnShape";
  }
}

/**
 * v0.11.1 (issue #76) — loose JSON-object importer rejected input
 * (not a JSON object, or contains `$value` / `value` leaves that
 * belong to a different format). Auto-detect chain falls through.
 */
export class NotLooseShape extends Error {
  constructor(message?: string) {
    super(
      message ??
        "NotLooseShape: input is not a flat JSON object of `{looseName: value}` pairs.",
    );
    this.name = "NotLooseShape";
  }
}

/**
 * v0.11.1 (issue #76) — auto-detect chain ran every importer and none
 * accepted the input. Carries per-format rejection reasons so the AI's
 * next turn can fix the input or fall back to `set_theme_tokens`.
 */
export class NoImporterMatched extends Error {
  readonly attempts: ReadonlyArray<{ format: string; reason: string }>;
  constructor(attempts: ReadonlyArray<{ format: string; reason: string }>) {
    const summary = attempts.map((a) => `${a.format}: ${a.reason}`).join("; ");
    super(
      `NoImporterMatched: none of the supported formats accepted the input. ${summary}. ` +
        "Fix the input or fall back to `set_theme_tokens` with a normalized object.",
    );
    this.name = "NoImporterMatched";
    this.attempts = attempts;
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
