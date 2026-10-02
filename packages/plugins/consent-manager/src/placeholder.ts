// SPDX-License-Identifier: MPL-2.0

/**
 * The consent-manager's built-in placeholder for a withheld embed.
 *
 * Core renders the site's own placeholder module when one exists; this
 * is what the visitor sees until then. Without it a site whose
 * placeholder was never designed could not render a page that holds a
 * single withheld embed.
 */

const escapeHtml = (v: string): string =>
  v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const CSS = `.caelo-consent-placeholder{border:1px dashed currentColor;border-radius:.5rem;padding:1rem;text-align:center;opacity:.85}
.caelo-consent-placeholder button{margin-top:.5rem;cursor:pointer}`;

/**
 * @param reason the deferral reason: a consent category key, or
 *   `unclassified` for a vendor nobody has ruled on yet
 * @param categoryLabel the operator's display name for that category
 */
export function defaultPlaceholder(
  reason: string,
  categoryLabel: string | null,
): { html: string; css: string } {
  if (reason === "unclassified" || categoryLabel === null) {
    // Nothing the visitor can grant: the operator has to classify the
    // vendor first, so offering a button would be a dead end.
    return {
      html: '<div class="caelo-consent-placeholder" data-consent-placeholder><p>This embedded content is waiting for review and is not shown yet.</p></div>',
      css: CSS,
    };
  }
  const label = escapeHtml(categoryLabel);
  const key = escapeHtml(reason);
  return {
    html: `<div class="caelo-consent-placeholder" data-consent-placeholder><p>This content is provided by a third party and loads only with your consent to &ldquo;${label}&rdquo;.</p><button type="button" data-consent-grant="${key}">Allow and load</button></div>`,
    css: CSS,
  };
}
