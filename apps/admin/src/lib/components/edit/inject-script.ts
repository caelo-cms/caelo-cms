// SPDX-License-Identifier: MPL-2.0

/**
 * Runtime injected at the bottom of every `/edit/preview-by-path/...`
 * (and the legacy `/edit/preview/[pageId]`) response. Four jobs:
 *
 *   1. `postMessage({kind: "caelo:ready"})` to the parent on first paint
 *      so the overlay knows the iframe is ready.
 *   2. `postMessage({kind: "caelo:navigated", pageId, locale, slug})` on
 *      every load — covers initial mount + click-through navigation so
 *      the parent's activePageId/URL/chat-branch context follows the
 *      user. The endpoint stamps `window.__caelo` with the resolved ids
 *      before this runtime executes.
 *   3. **Modifier-gated** hover affordance + click capture:
 *        - The "✏️ Edit" outline + pill render only while
 *          `Alt + Control + Meta` are all held (a `caelo-edit-mode`
 *          class on `<body>` toggles the CSS).
 *        - Clicks intercept + post `caelo:element-clicked` ONLY with
 *          the same combo held. Without modifier the iframe behaves
 *          like the live site — links navigate, forms submit, in-page
 *          JS runs.
 *   4. Listen for `{kind: "caelo:reload"}` from the parent and
 *      `location.reload()`.
 *
 * Exported as a string so the SvelteKit endpoint can splice it into
 * the response body inside a `<script>` tag. Self-contained — no
 * import resolution at runtime; the iframe runs the literal string.
 */

export const INJECT_SCRIPT = `
(function () {
  if (window.__caeloInjected) return;
  window.__caeloInjected = true;

  function origin() {
    try { return parent.location.origin; } catch (_e) { return "*"; }
  }

  // --- ready + navigated signals -------------------------------------
  function announce() {
    parent.postMessage({ kind: "caelo:ready" }, origin());
    var ctx = window.__caelo || {};
    if (ctx.pageId) {
      parent.postMessage(
        {
          kind: "caelo:navigated",
          pageId: ctx.pageId,
          locale: ctx.locale || "",
          slug: ctx.slug || "",
        },
        origin(),
      );
    }
  }
  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(announce, 0);
  } else {
    document.addEventListener("DOMContentLoaded", announce);
  }

  // --- modifier-gated hover + click affordance ----------------------
  // Only outline + pill while alt+ctrl+meta are held; cursor stays
  // default otherwise so clicks pass through to links/forms/JS.
  var STYLE_ID = "caelo-edit-style";
  if (!document.getElementById(STYLE_ID)) {
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent =
      "body.caelo-edit-mode [data-caelo-module-id]{cursor:crosshair;}" +
      "body.caelo-edit-mode [data-caelo-module-id]:hover{outline:2px solid #3b82f6;outline-offset:2px;position:relative;}" +
      "body.caelo-edit-mode [data-caelo-module-id]:hover::after{content:'\\u270F\\uFE0F Edit';position:absolute;top:-1.4rem;left:0;background:#3b82f6;color:#fff;font:500 11px/1 system-ui;padding:2px 6px;border-radius:3px;pointer-events:none;z-index:2147483647;}";
    document.head.appendChild(s);
  }

  function isEditModifier(ev) {
    return !!(ev && ev.altKey && ev.ctrlKey && ev.metaKey);
  }

  function setEditMode(on) {
    var body = document.body;
    if (!body) return;
    if (on) body.classList.add("caelo-edit-mode");
    else body.classList.remove("caelo-edit-mode");
  }

  document.addEventListener("keydown", function (ev) {
    if (isEditModifier(ev)) setEditMode(true);
  });
  document.addEventListener("keyup", function () {
    setEditMode(false);
  });
  window.addEventListener("blur", function () {
    setEditMode(false);
  });

  function findModuleAncestor(el) {
    var cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.hasAttribute && cur.hasAttribute("data-caelo-module-id")) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  function findLinkAncestor(el) {
    var cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.tagName === "A" && cur.getAttribute("href")) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  document.addEventListener(
    "click",
    function (ev) {
      var t = ev.target;
      // Edit-mode click on a tagged module → chip up.
      if (isEditModifier(ev)) {
        var el = t && t.nodeType === 1 ? findModuleAncestor(t) : null;
        if (!el) return;
        ev.preventDefault();
        ev.stopPropagation();
        var moduleId = el.getAttribute("data-caelo-module-id") || "";
        var label =
          (el.getAttribute("aria-label") || "").trim() ||
          (el.tagName.toLowerCase() + (el.id ? "#" + el.id : ""));
        var selector =
          el.tagName.toLowerCase() +
          (el.id ? "#" + el.id : "") +
          (el.className && typeof el.className === "string"
            ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".")
            : "");
        parent.postMessage(
          { kind: "caelo:element-clicked", moduleId: moduleId, selector: selector, label: label },
          origin(),
        );
        return;
      }
      // Plain click on a same-origin absolute link → rewrite to the
      // preview-by-path surface so the iframe stays inside /edit and
      // resolves the next page through pages.list. External and hash
      // links are left alone.
      var a = t && t.nodeType === 1 ? findLinkAncestor(t) : null;
      if (!a) return;
      if (a.target && a.target !== "" && a.target !== "_self") return;
      var href = a.getAttribute("href");
      if (!href) return;
      if (href.startsWith("#")) return;
      if (href.startsWith("mailto:") || href.startsWith("tel:")) return;
      // Absolute URL with another origin → leave alone.
      if (/^https?:\\/\\//i.test(href)) {
        try {
          var u = new URL(href, location.href);
          if (u.origin !== location.origin) return;
          href = u.pathname + u.search + u.hash;
        } catch (_e) {
          return;
        }
      }
      if (!href.startsWith("/")) return; // relative — let it resolve naturally
      if (href.startsWith("/edit/")) return; // already in the preview surface
      var ctx = window.__caelo || {};
      var locale = ctx.locale || "en";
      var path = href === "/" ? "/home" : href;
      ev.preventDefault();
      location.assign("/edit/preview-by-path/" + locale + path);
    },
    true,
  );

  // --- reload signal --------------------------------------------------
  window.addEventListener("message", function (ev) {
    if (!ev.data || typeof ev.data !== "object") return;
    if (ev.data.kind === "caelo:reload") {
      location.reload();
    }
  });
})();
`;
