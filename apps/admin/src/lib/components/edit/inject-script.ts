// SPDX-License-Identifier: MPL-2.0

/**
 * Runtime injected at the bottom of every `/edit/preview-by-path/...`
 * (and the legacy `/edit/preview/[pageId]`) response. Jobs:
 *
 *   1. `postMessage({kind: "caelo:ready"})` to the parent on first paint.
 *   2. `postMessage({kind: "caelo:navigated", pageId, locale, slug})` on
 *      every load — covers initial mount + click-through navigation so
 *      the parent's activePageId/URL/chat-branch context follows.
 *   3. **Edit mode toggle** — the parent posts
 *      `{kind: "caelo:set-edit-mode", on: true|false}` (driven by the
 *      toolbar Edit button). When ON: cursor=crosshair, hover outline +
 *      "✏ Edit" pill on every `[data-caelo-module-id]`, click captures
 *      → `caelo:element-clicked`. When OFF: the iframe behaves like the
 *      live site — links navigate, forms submit, JS runs.
 *   4. Listen for `{kind: "caelo:reload"}` and `location.reload()`.
 *
 * Out of edit mode, plain clicks on same-origin absolute links are
 * rewritten to the preview-by-path equivalent so internal navigation
 * stays inside the editor surface.
 *
 * Exported as a string so the SvelteKit endpoint can splice it into
 * the response body inside a `<script>` tag.
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

  // --- edit-mode hover affordance ------------------------------------
  var STYLE_ID = "caelo-edit-style";
  if (!document.getElementById(STYLE_ID)) {
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent =
      "body.caelo-edit-mode [data-caelo-module-id]{cursor:crosshair;}" +
      "body.caelo-edit-mode [data-caelo-module-id]:hover{outline:2px solid #3b82f6;outline-offset:2px;position:relative;}" +
      "body.caelo-edit-mode [data-caelo-module-id]:hover::after{content:'\\u270F\\uFE0F Edit';position:absolute;top:-1.4rem;left:0;background:#3b82f6;color:#fff;font:500 11px/1 system-ui;padding:2px 6px;border-radius:3px;pointer-events:none;z-index:2147483647;}" +
      "body.caelo-edit-mode::before{content:'Edit mode — click any element to add it as a chip';position:fixed;top:0;left:0;right:0;background:#3b82f6;color:#fff;font:500 12px/1.4 system-ui;padding:6px 12px;text-align:center;z-index:2147483646;pointer-events:none;}";
    document.head.appendChild(s);
  }

  function isEditMode() {
    return document.body && document.body.classList.contains("caelo-edit-mode");
  }
  function setEditMode(on) {
    if (!document.body) return;
    if (on) document.body.classList.add("caelo-edit-mode");
    else document.body.classList.remove("caelo-edit-mode");
  }

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
      // Edit-mode click → chip, regardless of element kind.
      if (isEditMode()) {
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
      // Browse mode: rewrite same-origin absolute hrefs into the
      // preview-by-path surface so the iframe stays inside /edit.
      var a = t && t.nodeType === 1 ? findLinkAncestor(t) : null;
      if (!a) return;
      if (a.target && a.target !== "" && a.target !== "_self") return;
      var href = a.getAttribute("href");
      if (!href) return;
      if (href.startsWith("#")) return;
      if (href.startsWith("mailto:") || href.startsWith("tel:")) return;
      if (/^https?:\\/\\//i.test(href)) {
        try {
          var u = new URL(href, location.href);
          if (u.origin !== location.origin) return;
          href = u.pathname + u.search + u.hash;
        } catch (_e) {
          return;
        }
      }
      if (!href.startsWith("/")) return;
      if (href.startsWith("/edit/")) return;
      var ctx = window.__caelo || {};
      var locale = ctx.locale || "en";
      var path = href === "/" ? "/home" : href;
      ev.preventDefault();
      location.assign("/edit/preview-by-path/" + locale + path);
    },
    true,
  );

  // --- parent → iframe messages: set-edit-mode + reload ---------------
  window.addEventListener("message", function (ev) {
    if (!ev.data || typeof ev.data !== "object") return;
    if (ev.data.kind === "caelo:set-edit-mode") {
      setEditMode(!!ev.data.on);
    } else if (ev.data.kind === "caelo:reload") {
      location.reload();
    }
  });

  // Escape exits edit mode as a safety net for users who pressed the
  // toggle and want out without reaching for the toolbar.
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && isEditMode()) {
      setEditMode(false);
      parent.postMessage({ kind: "caelo:edit-mode-changed", on: false }, origin());
    }
  });
})();
`;
