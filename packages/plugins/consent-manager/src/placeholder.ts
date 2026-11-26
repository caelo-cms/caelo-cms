// SPDX-License-Identifier: MPL-2.0

/**
 * What stands in for a withheld embed.
 *
 * Two audiences, two texts. A visitor sees a placeholder only where
 * they can do something about it: content gated behind a consent
 * category, with a button to allow it. A vendor nobody has classified
 * yet is a question for the operator, not the visitor — the module is
 * left out of the built page entirely, and only the editor preview
 * shows `editorNotice` in its place, saying what is held back and why.
 */

import type { DeferralPlaceholderRef, DeferralPlaceholders } from "@caelo-cms/plugin-sdk";

const CSS = `.caelo-consent-placeholder{border:1px dashed currentColor;border-radius:.5rem;padding:1rem;text-align:center;opacity:.85}
.caelo-consent-placeholder button{margin-top:.5rem;cursor:pointer}`;

// Editor-only, so it looks like the editor rather than the site: it
// must read as "Caelo is telling you something", not as page content.
const NOTICE_CSS = `.caelo-consent-notice{box-sizing:border-box;margin:.5rem 0;padding:.75rem 1rem;border:1px dashed #2a64b8;border-radius:.5rem;background:#eef3fb;color:#1a1a1a;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:left}
.caelo-consent-notice strong{display:block;margin-bottom:.25rem}
.caelo-consent-notice p{margin:0 0 .5rem}
.caelo-consent-notice code{font-size:13px;background:#fff;padding:0 .25rem;border-radius:.25rem}
.caelo-consent-notice button{cursor:pointer;padding:.35rem .75rem;border:0;border-radius:.375rem;background:#2a64b8;color:#fff;font:inherit}`;

/**
 * The plugin's reviewed placeholders (#1729): markup in the manifest, so a
 * verdict names one and hands it text, which core escapes. A verdict can
 * never put markup of its own where a withheld embed was.
 */
export const DEFERRAL_PLACEHOLDERS: DeferralPlaceholders = {
  consent: {
    html: `<div class="caelo-consent-placeholder" data-consent-placeholder><p>This content is provided by a third party and loads only with your consent to &ldquo;{{category_label}}&rdquo;.</p><button type="button" data-consent-grant="{{category}}">Allow and load</button></div>`,
    css: CSS,
  },
  unreviewed: {
    html:
      `<div class="caelo-consent-notice" data-consent-notice>` +
      `<strong>Hidden from visitors: external content not reviewed yet</strong>` +
      `<p>This module loads content from <code>{{hosts}}</code>. External content stays off the page until you decide whether visitors have to consent to it first (and under which category) or whether it may load freely. Visitors see nothing here until then; this note shows only in the editor.</p>` +
      `<button type="button" data-caelo-ask-ai>Resolve in chat</button>` +
      `</div>`,
    css: NOTICE_CSS,
  },
};

/**
 * The visitor's placeholder for content gated behind a consent category.
 *
 * @param reason the consent category key
 * @param categoryLabel the operator's display name for that category
 */
export function defaultPlaceholder(reason: string, categoryLabel: string): DeferralPlaceholderRef {
  return { name: "consent", values: { category: reason, category_label: categoryLabel } };
}

/**
 * What the editor preview shows in place of a module whose vendor
 * nobody has classified yet: which hosts it reaches, that visitors get
 * nothing in its place, and what decision is missing. The button adds
 * the module to the current chat (core's `data-caelo-ask-ai`).
 *
 * @param hosts the third-party hosts the module loads from
 */
export function editorNotice(hosts: ReadonlyArray<string>): DeferralPlaceholderRef {
  return { name: "unreviewed", values: { hosts: hosts.join(", ") } };
}
