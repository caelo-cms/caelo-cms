// SPDX-License-Identifier: MPL-2.0

import { EDIT_AFFORDANCES_SCRIPT } from "./edit-affordances-script.js";

/**
 * Runtime injected at the bottom of every `/edit/preview-by-path/...`
 * (and the legacy `/edit/preview/[pageId]`) response. Jobs:
 *
 *   1. `postMessage({kind: "caelo:ready"})` to the parent on first paint.
 *   2. `postMessage({kind: "caelo:navigated", pageId, slug})` on
 *      every load — covers initial mount + click-through navigation so
 *      the parent's activePageId/URL/chat-branch context follows.
 *   3. **Editing affordances** (`EDIT_AFFORDANCES_SCRIPT`) — right-click
 *      menu + selection toolbar that post `caelo:element-referenced`
 *      (optionally with an Ask AI prompt). There is no edit mode: left
 *      clicks always behave like the live site.
 *   4. Listen for `{kind: "caelo:reload"}` and `location.reload()`.
 *
 * Plain clicks on same-origin absolute links are rewritten to the
 * preview-by-path equivalent so internal navigation stays inside the
 * editor surface.
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
          slug: ctx.slug || "",
          path: ctx.path || "",
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
      // Rewrite same-origin absolute hrefs into the
      // preview-by-path surface so the iframe stays inside /edit.
      var a = t && t.nodeType === 1 ? findLinkAncestor(t) : null;
      if (!a) return;
      if (a.target && a.target !== "" && a.target !== "_self") return;
      var href = a.getAttribute("href");
      if (!href) return;
      // Epic #724 — the server resolves every internal reference before
      // the iframe sees it; one still reading caelo:page/<id> points at a
      // deleted page (the preview flags it as link-target-missing). The
      // browser cannot follow that scheme, so swallow the click instead
      // of leaving the iframe on an error page.
      if (href.startsWith("caelo:")) {
        ev.preventDefault();
        return;
      }
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
      var path = href === "/" ? "" : href;
      ev.preventDefault();
      // v0.9.7 — preserve the iframe's own ?branch=<uuid> across
      // click-through navigation. The iframe was loaded with the chat's
      // branch in its URL; without re-attaching it here, preview-by-path
      // would run main-only and 404 on every branched page. Using URL +
      // URLSearchParams handles the rare case where \`path\` itself
      // already carries a query string (preserved from the original
      // link's u.search above).
      var newUrl = "/edit/preview-by-path" + path;
      var current = new URLSearchParams(location.search);
      var branch = current.get("branch");
      if (branch) {
        var nu = new URL(newUrl, location.origin);
        nu.searchParams.set("branch", branch);
        newUrl = nu.pathname + nu.search + nu.hash;
      }
      location.assign(newUrl);
    },
    true,
  );

  // --- right-click menu, selection toolbar, Ask AI --------------------
  ${EDIT_AFFORDANCES_SCRIPT}

  // --- parent → iframe messages: reload --------------------------------
  // Only the editor that embeds us may drive the iframe: the previewed
  // site's own scripts (source = this window) and any other frame must not
  // force reloads (PR #863, M-08).
  window.addEventListener("message", function (ev) {
    if (ev.source !== window.parent || window.parent === window) return;
    if (ev.origin !== location.origin) return;
    if (!ev.data || typeof ev.data !== "object") return;
    if (ev.data.kind === "caelo:reload") location.reload();
  });
})();
`;
