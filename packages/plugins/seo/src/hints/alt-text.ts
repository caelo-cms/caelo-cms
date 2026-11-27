// SPDX-License-Identifier: MPL-2.0

/**
 * #1757 — alt text style, as write hints right after the AI wrote an alt
 * text: a library image's alt (`media_alt`), the `<img alt>` of module
 * markup, or a content value of an alt field. Rules of thumb, so hints and
 * never findings (an alt that is missing or a file name is a finding, at
 * the Stage: ../checks/page-rules.ts):
 *
 * - "Image of …" — screen readers already announce an image.
 * - longer than {@link ALT_LONG} characters — screen readers read it in one
 *   breath; details belong in a caption or the text around it.
 * - shorter than {@link ALT_SHORT} characters — too short to say what the
 *   picture shows.
 * - the same alt on two images of one module — each image says something
 *   of its own, or one is decorative (`alt=""`).
 */

import type { PluginWrite } from "@caelo-cms/plugin-sdk";
import { isFileNameAlt } from "../checks/page-rules.js";
import type { SeoWriteHintRule } from "./index.js";

/** An alt above this many characters reads as a paragraph (a common guideline: 125). */
export const ALT_LONG = 125;
/** An alt below this many characters rarely says what a picture shows. */
export const ALT_SHORT = 5;

const REDUNDANT_PREFIX =
  /^(?:an?\s+)?(?:image|picture|photo|photograph|graphic|icon)\s+(?:of|showing)\b|^(?:ein\s+)?(?:bild|foto|grafik)\s+(?:von|mit|zeigt)\b/i;

/** Alt texts of `<img>` tags in markup (attributes quoted, as Caelo's modules write them). */
function altsOfMarkup(html: string): string[] {
  const out: string[] = [];
  for (const tag of html.matchAll(/<img\b[^>]*>/gi)) {
    const m = /\salt\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag[0]);
    const alt = m?.[2] ?? m?.[3];
    // `{{field}}` placeholders are filled from content values, checked there.
    if (alt !== undefined && !alt.includes("{{")) out.push(alt);
  }
  return out;
}

/** Alt texts among content values: fields whose name says alt. */
function altsOfValues(values: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(values).flatMap(([key, value]) =>
    /(?:^|_)alt(?:_|$)|alt_text/i.test(key) && typeof value === "string" ? [value] : [],
  );
}

/** The hints one alt text gets. */
export function altTextHints(alt: string): string[] {
  const a = alt.trim();
  if (a === "") return [];
  const quoted = `"${a.length > 60 ? `${a.slice(0, 59)}…` : a}"`;
  const out: string[] = [];
  if (isFileNameAlt(a)) {
    out.push(
      `Alt text ${quoted} is a file name: describe what the image shows (the Stage audit blocks this one).`,
    );
  } else if (REDUNDANT_PREFIX.test(a)) {
    out.push(
      `Alt text ${quoted} starts by calling itself an image: screen readers already say so, so start with what it shows.`,
    );
  }
  if (a.length > ALT_LONG) {
    out.push(
      `Alt text ${quoted} has ${a.length} characters: keep it under about ${ALT_LONG} and put details in a caption or the text around it.`,
    );
  } else if (a.length < ALT_SHORT) {
    out.push(
      `Alt text ${quoted} is very short: say in a few words what the image shows, or use alt="" if it is decorative.`,
    );
  }
  return out;
}

/** Alt texts two images of one write share. */
function sharedAlts(alts: readonly string[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const a of alts.map((x) => x.trim()).filter((x) => x !== "")) {
    if (seen.has(a)) twice.add(a);
    seen.add(a);
  }
  return [...twice].map(
    (a) =>
      `Two images here share the alt text "${a}": give each its own description, or alt="" to the decorative one.`,
  );
}

/** The alt text hint family. */
export const ALT_TEXT_HINT_RULE: SeoWriteHintRule = {
  name: "alt-text",
  async hints(_ctx, writes: readonly PluginWrite[]) {
    const out: string[] = [];
    for (const w of writes) {
      const alts =
        w.kind === "media_alt"
          ? [w.alt]
          : w.kind === "module"
            ? altsOfMarkup(w.html)
            : w.kind === "values"
              ? altsOfValues(w.values)
              : [];
      for (const alt of alts) out.push(...altTextHints(alt));
      if (w.kind === "module") out.push(...sharedAlts(alts));
    }
    return out;
  },
};
