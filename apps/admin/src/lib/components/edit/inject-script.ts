// SPDX-License-Identifier: MPL-2.0

/**
 * Runtime injected at the bottom of every `/edit/preview/[pageId]`
 * response. Three jobs:
 *
 *   1. `postMessage({kind: "caelo:ready"})` to the parent on first
 *      paint so the overlay knows the iframe is ready.
 *   2. Hover affordance: outline + small "✏️ Edit" pill on every
 *      element with `data-caelo-module-id`. Click → posts
 *      `{kind: "caelo:element-clicked", moduleId, selector, label}` to
 *      the parent.
 *   3. Listen for `{kind: "caelo:reload"}` from the parent and
 *      `location.reload()`. Phase-2 surgical swap deferred to P6.7.1.
 *
 * Exported as a string so the SvelteKit endpoint can splice it into
 * the response body inside a `<script>` tag. Self-contained — no
 * import resolution at runtime; the iframe runs the literal string.
 *
 * Inline comments in the injected code are intentional — this is the
 * one place a contributor reading the source of a deployed iframe
 * would land, and the runtime is small enough that comments help.
 */

export const INJECT_SCRIPT = `
(function () {
  if (window.__caeloInjected) return;
  window.__caeloInjected = true;

  function origin() {
    try { return parent.location.origin; } catch (_e) { return "*"; }
  }

  // --- ready signal ---------------------------------------------------
  function announce() {
    parent.postMessage({ kind: "caelo:ready" }, origin());
  }
  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(announce, 0);
  } else {
    document.addEventListener("DOMContentLoaded", announce);
  }

  // --- hover + click affordance --------------------------------------
  var STYLE_ID = "caelo-edit-style";
  if (!document.getElementById(STYLE_ID)) {
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent =
      "[data-caelo-module-id]{cursor:pointer;}" +
      "[data-caelo-module-id]:hover{outline:2px solid #3b82f6;outline-offset:2px;position:relative;}" +
      "[data-caelo-module-id]:hover::after{content:'✏️ Edit';position:absolute;top:-1.4rem;left:0;background:#3b82f6;color:#fff;font:500 11px/1 system-ui;padding:2px 6px;border-radius:3px;pointer-events:none;z-index:2147483647;}";
    document.head.appendChild(s);
  }

  function findModuleAncestor(el) {
    var cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.hasAttribute && cur.hasAttribute("data-caelo-module-id")) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  document.addEventListener(
    "click",
    function (ev) {
      var t = ev.target;
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
