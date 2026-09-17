// SPDX-License-Identifier: MPL-2.0

/**
 * Tracking tags — third-party code the site wants to run, each pinned
 * to a consent category so it cannot run before the visitor agrees.
 *
 * ## Why the runtime injects them rather than the page
 *
 * A tag written into the page's HTML has already run by the time any
 * script could decide whether it should. So no tag reaches the document
 * at build time: the runtime holds them and injects the ones whose
 * category is granted. The check therefore happens before the request,
 * not after it.
 *
 * ## `necessary` is not a shortcut
 *
 * A tag in the `necessary` category runs for everyone, unasked. That is
 * correct for a session cookie and wrong for anything that measures or
 * follows a visitor, so registering one there requires a written
 * justification — enforced at the operation, not left to reviewer
 * discipline. Without it, "necessary" is simply the category that makes
 * the banner stop being an obstacle.
 */

export interface TagRow {
  id: string;
  name: string;
  vendor: string;
  category_key: string;
  script_src: string;
  inline_snippet: string;
  position: string;
  justification: string;
  enabled: boolean;
}

/** What the runtime needs to inject one tag. */
export interface BakedTag {
  readonly name: string;
  readonly category: string;
  readonly src: string;
  readonly inline: string;
  readonly position: "head" | "body_end";
}

/**
 * Vendors common enough that the operator should not have to look up
 * the snippet. Purely a convenience for `add_tag`; an unknown vendor is
 * fine, it just has to carry its own `scriptSrc` or snippet.
 *
 * Categories here are the conservative reading: anything that measures
 * or follows a visitor is never `necessary`.
 */
export const KNOWN_VENDORS: Readonly<
  Record<string, { category: string; scriptSrc?: string; note: string }>
> = {
  "google-analytics": {
    category: "analytics",
    scriptSrc: "https://www.googletagmanager.com/gtag/js",
    note: "Google Analytics 4. Needs the measurement id as `config`.",
  },
  "google-tag-manager": {
    category: "marketing",
    scriptSrc: "https://www.googletagmanager.com/gtm.js",
    note: "GTM can load anything, so it is treated as marketing — the strictest category its contents could need.",
  },
  "meta-pixel": {
    category: "marketing",
    note: "Meta/Facebook pixel. Inline snippet from the Events Manager.",
  },
  matomo: {
    category: "analytics",
    note: "Self-hosted Matomo. Cookie-less mode may qualify as necessary — document it in the justification if you claim that.",
  },
  hotjar: {
    category: "analytics",
    note: "Session recording. Record the retention period in the justification.",
  },
};

/**
 * The injector, appended to the runtime with the site's tags baked in.
 * Replaces the stub the runtime ships with when no tags exist.
 */
export function buildTagInjector(tags: ReadonlyArray<BakedTag>): string {
  return [
    `var TAGS = ${JSON.stringify(tags)};`,
    `var loadedTags = {};`,
    `function loadTags() {`,
    `  for (var i = 0; i < TAGS.length; i++) {`,
    `    var tag = TAGS[i];`,
    `    if (loadedTags[tag.name]) continue;`,
    `    if (!isGranted(tag.category)) continue;`,
    `    loadedTags[tag.name] = true;`,
    `    var target = tag.position === "head" ? document.head : document.body;`,
    `    if (tag.src) {`,
    `      var el = document.createElement("script");`,
    `      el.async = true;`,
    `      el.src = tag.src;`,
    `      el.setAttribute("data-caelo-tag", tag.name);`,
    `      target.appendChild(el);`,
    `    }`,
    `    if (tag.inline) {`,
    `      var inline = document.createElement("script");`,
    `      inline.text = tag.inline;`,
    `      inline.setAttribute("data-caelo-tag", tag.name);`,
    `      target.appendChild(inline);`,
    `    }`,
    `  }`,
    `}`,
  ].join("\n");
}
