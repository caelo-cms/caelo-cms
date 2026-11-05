// SPDX-License-Identifier: MPL-2.0

/**
 * The browser side of the baked thread (#1169).
 *
 * A long thread bakes only its newest comments, so something has to bring
 * the rest to the visitor, and `component.mounted` cannot: nothing mounts a
 * plugin's Web Component on a built page yet (#455). This file reaches the
 * browser through `buildAssets`, the channel that does run.
 *
 * It works on the bake's own markup, so it needs no custom element:
 *
 *   [data-comment-thread]    the list of comments, newest approval first
 *   [data-comment-id]        one comment; dedupes what a feed repeats
 *   [data-older-comments]    the "newest N of M" line; only on a thread
 *                            longer than the bake; `data-cursor` holds the
 *                            position of the next page as JSON
 *
 * It starts at DOMContentLoaded, not when the file runs. Assets load in
 * plugin-slug order, so a consent provider's runtime can come after this
 * one, and a read before it would go out without the visitor's decision:
 * the gateway takes that as "no decision" and drops the visitor id. Every
 * deferred script has run by DOMContentLoaded, whichever plugins are active,
 * so nothing here names a plugin or waits for one that may not exist.
 *
 * On load it asks for what was approved after the bake (`since` =
 * `data-baked-at`, CMS_REQUIREMENTS §6.1) and puts that on top. A button
 * then reads older pages on demand, so a long thread costs a visitor who
 * never asks for it one small request. The button stays shut until that
 * first read settled: it can replace the thread and its cursor, and a page
 * read from the old cursor would skip what lies between. More new comments than one page
 * means the bake is far behind (it waits for the next Publish live after a
 * new plugin version), so the thread is read from the top instead of merged.
 * The same path fills a placeholder nothing baked into.
 *
 * Visitor text only ever reaches the DOM through `textContent`. Pages
 * without a comments region stop at the first line of work: this file loads
 * on every page of the site.
 */

/** Sent as `runtime.js` by `buildAssets`. */
export const THREAD_RUNTIME_JS = `(function () {
  "use strict";
  var regions = document.querySelectorAll('div[data-caelo-plugin="comments"][data-page-id]');
  if (regions.length === 0) return;

  function read(args) {
    var headers = { "Content-Type": "application/json" };
    var consent = window.caeloConsent;
    var decision =
      consent && typeof consent.decisionHeader === "function" ? consent.decisionHeader() : null;
    if (decision) headers["x-caelo-consent"] = decision;
    return fetch("/api/plugin/comments/list_approved", {
      method: "POST",
      headers: headers,
      credentials: "same-origin",
      body: JSON.stringify(args),
    })
      .then(function (res) { return res.json(); })
      .then(function (json) {
        if (!json.ok || !json.data) throw new Error("list_approved was refused");
        return json.data;
      });
  }

  function articleOf(c) {
    var article = document.createElement("article");
    article.className = "comment";
    article.setAttribute("data-comment-id", c.id);
    var header = document.createElement("header");
    header.textContent = c.author_name + " \\u00b7 " + new Date(c.submitted_at).toISOString();
    var body = document.createElement("div");
    body.className = "body";
    body.textContent = c.content;
    article.appendChild(header);
    article.appendChild(body);
    return article;
  }

  function mount(region) {
    var pageId = region.getAttribute("data-page-id");
    var bakedAt = region.getAttribute("data-baked-at");
    var thread = region.querySelector("[data-comment-thread]");
    if (!thread) {
      thread = document.createElement("div");
      thread.setAttribute("data-comment-thread", "");
      region.appendChild(thread);
    }
    var seen = {};
    thread.querySelectorAll("[data-comment-id]").forEach(function (el) {
      seen[el.getAttribute("data-comment-id")] = true;
    });
    var line = region.querySelector("[data-older-comments]");
    var cursor = line ? JSON.parse(line.getAttribute("data-cursor")) : null;
    var button = null;

    function dropLine() {
      if (line) line.remove();
      line = null;
    }

    function syncButton() {
      if (!cursor) {
        if (button) button.remove();
        button = null;
        dropLine();
        return;
      }
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.textContent = "Show older comments";
        button.addEventListener("click", showOlder);
        region.appendChild(button);
      }
      button.disabled = false;
    }

    function add(comments, onTop) {
      var fresh = comments.filter(function (c) { return !seen[c.id]; });
      if (onTop) fresh.reverse();
      fresh.forEach(function (c) {
        seen[c.id] = true;
        var article = articleOf(c);
        if (onTop) thread.insertBefore(article, thread.firstChild);
        else thread.appendChild(article);
      });
    }

    function showOlder() {
      button.disabled = true;
      read({ pageId: pageId, before: cursor })
        .then(function (page) {
          add(page.comments, false);
          cursor = page.nextCursor;
          dropLine();
          syncButton();
        })
        .catch(function (e) {
          console.warn("comments: could not load older comments", e);
          button.disabled = false;
        });
    }

    function readFromTop() {
      return read({ pageId: pageId }).then(function (page) {
        thread.textContent = "";
        seen = {};
        dropLine();
        add(page.comments, false);
        cursor = page.nextCursor;
      });
    }

    syncButton();
    if (button) button.disabled = true;
    var first = bakedAt
      ? read({ pageId: pageId, since: bakedAt }).then(function (page) {
          if (page.nextCursor) return readFromTop();
          add(page.comments, true);
        })
      : readFromTop();
    first
      .catch(function (e) {
        console.warn("comments: could not read new comments", e);
      })
      .then(syncButton);
  }

  var started = false;
  function start() {
    if (started) return;
    started = true;
    regions.forEach(mount);
  }
  if (document.readyState === "complete") {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start);
    window.addEventListener("load", start);
  }
})();
`;
