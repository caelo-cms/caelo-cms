// SPDX-License-Identifier: MPL-2.0

/**
 * Release notes in the Owner's language (#862) for Settings → Updates.
 *
 * The GitHub release body is the commit log `scripts/release.ts` groups by
 * conventional-commit type: `### Features` / `### Fixes` / `### Docs` / …,
 * each line `- <sha> <subject> (#issue) (#pr)`, with ` ⚠ BREAKING` on a
 * breaking commit. An Owner cannot act on hashes, issue numbers or
 * "BREAKING". This turns the body into three short lists — New, Fixed,
 * Security — and the breaking marker into one sentence of what the Owner
 * has to do. Docs, refactors, chores and tests are left out: nothing about
 * the site changes for the Owner. The full log stays one click away
 * ("All changes on GitHub").
 *
 * Pure: no I/O, so the page and its tests share one implementation.
 */

/** The Owner-facing release notes, grouped. Empty groups are empty arrays. */
export interface OwnerReleaseNotes {
  readonly added: readonly string[];
  readonly fixed: readonly string[];
  readonly security: readonly string[];
  /** What the Owner must do for a breaking change; null when nothing is breaking. */
  readonly breaking: string | null;
}

/** The default answer to "what do I have to do?" when a change is breaking. */
export const BREAKING_NOTHING_TO_DO = "Nothing to do — Caelo handles this during the update.";

/**
 * Words that mark a fix as a security fix. Deliberately narrow: a false
 * "Security" label would alarm the Owner for nothing, a missed one still
 * shows under "Fixed".
 */
const SECURITY_WORDS =
  /\b(security|vulnerab\w*|CVE-\d|GHSA-|XSS|CSRF|spoof\w*|injection|privilege\w*|harden\w*|sandbox)\b/i;

/** `scripts/release.ts` section headings → the Owner group they feed (null = left out). */
const SECTION_GROUP: Readonly<Record<string, "added" | "fixed" | null>> = {
  features: "added",
  fixes: "fixed",
  security: "fixed",
  refactors: null,
  docs: null,
  chores: null,
  tests: null,
  other: null,
};

/** Conventional-commit types an "Other" line may still carry. */
const TYPE_GROUP: Readonly<Record<string, "added" | "fixed">> = {
  feat: "added",
  fix: "fixed",
};

const BREAKING_MARKER = /\s*⚠\s*BREAKING\b/;
const LEADING_SHA = /^[0-9a-f]{7,40}\s+/;
const CONVENTIONAL_PREFIX = /^(\w+)(?:\([^)]*\))?!?:\s*/;
/** A parenthesised group that names an issue or PR: `(#849)`, `(#635, 4/4, release after #767)`. */
const REF_GROUP = /\s*\([^()]*#\d+[^()]*\)/g;
const BARE_REF = /\s*#\d+\b/g;

/**
 * One commit subject as an Owner reads it: no hash, no `type(scope):`, no
 * issue/PR references, first letter upper-case.
 *
 * @returns the cleaned text and the conventional type when the line had one
 */
export function ownerLine(raw: string): { text: string; type: string | null; breaking: boolean } {
  let text = raw.trim().replace(/^[-*]\s+/, "");
  const breaking =
    BREAKING_MARKER.test(text) || /^\w+(?:\([^)]*\))?!:/.test(text.replace(LEADING_SHA, ""));
  text = text.replace(BREAKING_MARKER, "").replace(LEADING_SHA, "");
  let type: string | null = null;
  const prefix = CONVENTIONAL_PREFIX.exec(text);
  if (prefix?.[1] && /^[a-z]+$/.test(prefix[1])) {
    type = prefix[1];
    text = text.slice(prefix[0].length);
  }
  text = text
    .replace(REF_GROUP, "")
    .replace(BARE_REF, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  text = text.replace(/[\s,;:]+$/, "");
  return { text: text.charAt(0).toUpperCase() + text.slice(1), type, breaking };
}

/**
 * Turn a release body into Owner-facing notes.
 *
 * @param body the GitHub release body (markdown from `scripts/release.ts`)
 * @param options.breakingAction what the Owner must do for a breaking
 *   change, when the release says so; otherwise {@link BREAKING_NOTHING_TO_DO}
 *   — every breaking change Caelo ships is applied by the update itself
 *   (contract migrations run in the upgrader, never by hand).
 */
export function ownerReleaseNotes(
  body: string,
  options: { readonly breakingAction?: string | null } = {},
): OwnerReleaseNotes {
  const added: string[] = [];
  const fixed: string[] = [];
  const security: string[] = [];
  let breaking = false;
  let section: string | null = null;
  for (const raw of body.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading?.[1]) {
      section = heading[1].trim().toLowerCase();
      continue;
    }
    if (!/^[-*]\s+/.test(line)) continue;
    const parsed = ownerLine(line);
    // A breaking change counts even in a section the Owner does not see.
    breaking ||= parsed.breaking;
    if (parsed.text.length === 0) continue;
    const fromSection = section !== null ? SECTION_GROUP[section] : undefined;
    const group =
      fromSection !== undefined && section !== "other"
        ? fromSection
        : parsed.type !== null
          ? (TYPE_GROUP[parsed.type] ?? null)
          : null;
    if (group === null) continue;
    if (section === "security" || (group === "fixed" && SECURITY_WORDS.test(parsed.text))) {
      security.push(parsed.text);
    } else if (group === "added") {
      added.push(parsed.text);
    } else {
      fixed.push(parsed.text);
    }
  }
  const action = options.breakingAction?.trim();
  return {
    added,
    fixed,
    security,
    breaking: breaking ? action || BREAKING_NOTHING_TO_DO : null,
  };
}

/** Whether there is anything to show besides the GitHub link. */
export function hasOwnerNotes(notes: OwnerReleaseNotes): boolean {
  return (
    notes.added.length > 0 ||
    notes.fixed.length > 0 ||
    notes.security.length > 0 ||
    notes.breaking !== null
  );
}
