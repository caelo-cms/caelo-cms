// SPDX-License-Identifier: MPL-2.0

import { EDIT_AFFORDANCES_SCRIPT } from "./edit-affordances-script.js";
import { FIELD_EDIT_SCRIPT } from "./field-edit-script.js";
import { LINK_IMAGE_EDIT_SCRIPT } from "./link-image-edit-script.js";

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
 *      (Ask AI only flags it; no instruction). There is no edit mode: left
 *      clicks always behave like the live site. `FIELD_EDIT_SCRIPT` adds
 *      in-place text editing of marked fields (#917), `LINK_IMAGE_EDIT_SCRIPT`
 *      link and image editing (#918).
 *   4. Listen for `{kind: "caelo:reload"}` (answered with a
 *      `caelo:navigate` to the current page, scroll position included),
 *      and for `caelo:page-paths` (link-target suggestions, #918).
 *
 * Plain clicks on same-origin absolute links are rewritten to the
 * preview-by-path equivalent so internal navigation stays inside the
 * editor surface — as a `caelo:navigate` request: the editor navigates
 * the iframe (#946, see `navigate` below).
 *
 * The runtime runs inside the opaque-origin sandbox (#946): it reaches the
 * editor only through `postToEditor()`, on the channel from its URL.
 *
 * Exported as a string so the SvelteKit endpoint can splice it into
 * the response body inside a `<script>` tag.
 */

export const INJECT_SCRIPT = `
(function () {
  if (window.__caeloInjected) return;
  window.__caeloInjected = true;

  // #946 — the preview runs in an opaque-origin sandbox and cannot read
  // the editor's origin from its window. location.origin is the origin
  // of this document's URL — the admin's, where the editor lives — so
  // messages go there and nowhere else. The editor's random channel (from
  // the iframe URL) rides on every message to it: a page that does not
  // know it — an external site the preview navigated to — cannot talk to
  // the editor.
  var editorOrigin = location.origin;
  var channel = new URLSearchParams(location.search).get("channel");
  if (channel && !/^[0-9a-f-]{36}$/.test(channel)) channel = null;
  function postToEditor(msg) {
    if (!channel || window.parent === window) return;
    msg.channel = channel;
    parent.postMessage(msg, editorOrigin);
  }

  // --- ready + navigated signals -------------------------------------
  function announce() {
    postToEditor({ kind: "caelo:ready" });
    var ctx = window.__caelo || {};
    if (ctx.pageId) {
      postToEditor({
        kind: "caelo:navigated",
        pageId: ctx.pageId,
        slug: ctx.slug || "",
        path: ctx.path || "",
      });
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
      // A link label being edited in place must not navigate (#917).
      if (t && t.nodeType === 1 && isEditing(t)) {
        ev.preventDefault();
        return;
      }
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
      var nu = new URL("/edit/preview-by-path" + path, location.origin);
      var branch = new URLSearchParams(location.search).get("branch");
      if (branch) nu.searchParams.set("branch", branch);
      navigate(nu.pathname + nu.search + nu.hash);
    },
    true,
  );

  // #946 — the preview cannot navigate ITSELF to another preview page: in
  // the opaque-origin sandbox its own navigations carry no session cookie
  // (so module scripts cannot open admin pages as the operator either). The
  // editor navigates the iframe instead; it re-validates the target and
  // attaches its channel. Without a channel (a frame no editor listens to)
  // a click goes nowhere.
  function navigate(href) {
    postToEditor({ kind: "caelo:navigate", href: href });
  }

  // A reload is a navigation the editor runs too; the scroll position
  // rides along in the URL and is restored once the page has loaded.
  function reload() {
    var u = new URL(location.href);
    u.searchParams.delete("channel");
    var y = Math.round(window.scrollY || 0);
    if (y > 0) u.searchParams.set("scroll", String(y));
    else u.searchParams.delete("scroll");
    navigate(u.pathname + u.search + u.hash);
  }
  var restoreY = parseInt(new URLSearchParams(location.search).get("scroll") || "", 10);
  if (restoreY > 0) {
    window.addEventListener("load", function () {
      window.scrollTo(0, restoreY);
    });
  }

  // --- right-click menu, selection toolbar, Ask AI --------------------
  ${EDIT_AFFORDANCES_SCRIPT}
  ${FIELD_EDIT_SCRIPT}
  ${LINK_IMAGE_EDIT_SCRIPT}

  // --- parent → iframe messages: reload --------------------------------
  // Only the editor that embeds us may drive the iframe: the previewed
  // site's own scripts (source = this window) and any other frame must not
  // force reloads (PR #863, M-08). Source + origin prove the sender: no
  // script in here can post as the parent window from the admin origin.
  // The editor never sends the channel — it must not reach whatever other
  // document this frame may hold (#946) — and only one that set it listens.
  window.addEventListener("message", function (ev) {
    if (!channel) return;
    if (ev.source !== window.parent || window.parent === window) return;
    if (ev.origin !== editorOrigin) return;
    if (!ev.data || typeof ev.data !== "object") return;
    if (ev.data.kind === "caelo:reload") reload();
    else if (ev.data.kind === "caelo:page-paths" && Array.isArray(ev.data.pages)) {
      pagePaths = ev.data.pages;
    }
  });
})();
`;
