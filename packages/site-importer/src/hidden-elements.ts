// SPDX-License-Identifier: MPL-2.0

/**
 * issue #415 — browser-side hidden-element removal for the inspect cleanup
 * stage.
 *
 * Responsive sites ship the SAME content twice (desktop nav + mobile
 * drawer), carousels keep offscreen clone slides in the DOM, and consent
 * modals sit hidden until triggered — all invisible in the rendered page
 * but fully present in `page.content()`, which made real homepages ~40%
 * redundant as Markdown. Visibility is LAYOUT knowledge, so the pass runs
 * inside the rendered page (`page.evaluate`) — a string-script constant in
 * the same style as `COLLECT_STYLE_SAMPLES_SCRIPT` — and only on the
 * rendered path; the static-fetch fallback cannot run it (the caller
 * surfaces that skip loudly, CLAUDE.md §2).
 *
 * The script REMOVES every `<body>` subtree that is hidden by
 * `display:none` / `visibility:hidden` (computed), a `display:none`
 * ancestor (`offsetParent === null`), or `aria-hidden="true"` (decorative
 * by definition — assistive tech ignores it, so a text rendition drops it
 * too), and returns the number of removed subtrees. Callers MUST read the
 * full DOM BEFORE evaluating this (query_page_html keeps the unstripped
 * HTML) and MUST surface the returned count.
 */

export const REMOVE_HIDDEN_ELEMENTS_SCRIPT = `(() => {
  const body = document.body;
  if (!body) return 0;
  // Tags that are "hidden" by nature but already dropped by the Markdown
  // converter's skip list — removing them here would only inflate the
  // reported count with noise (every <script> would count as "hidden").
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META", "TITLE"]);
  const isHidden = (el) => {
    if (el.getAttribute("aria-hidden") === "true") return true;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return true;
    // offsetParent === null also catches a display:none ANCESTOR — but it is
    // null for position:fixed (and, in some engines, sticky) elements too,
    // which are typically VISIBLE chrome (a fixed header/cookie bar), so
    // those are exempt here; the consent pass judges cookie bars by
    // fingerprint instead.
    if (el.offsetParent === null && cs.position !== "fixed" && cs.position !== "sticky") {
      return true;
    }
    return false;
  };
  let removed = 0;
  // querySelectorAll returns document order, so ancestors are visited before
  // descendants: removing a hidden ancestor disconnects its subtree and the
  // isConnected check skips the already-removed descendants (each hidden
  // SUBTREE counts once).
  for (const el of Array.from(body.querySelectorAll("*"))) {
    if (!el.isConnected) continue;
    if (SKIP.has(el.tagName)) continue;
    // SVG/MathML elements have no offsetParent/layout API — leave them; the
    // Markdown converter skips svg subtrees anyway.
    if (!(el instanceof HTMLElement)) continue;
    if (isHidden(el)) {
      el.remove();
      removed += 1;
    }
  }
  return removed;
})()`;
