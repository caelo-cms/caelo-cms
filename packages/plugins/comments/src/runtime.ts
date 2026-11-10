// SPDX-License-Identifier: MPL-2.0

/**
 * The browser side of the comments plugin (#1169, #1511).
 *
 * ## Who owns what
 *
 * The same split as the consent banner: the PLUGIN owns behaviour, the
 * module the AI writes owns everything visible. The module carries the
 * heading, the form, its labels and the hint above the button, styled
 * with the site's theme tokens and worded with `{{site_text.<key>}}`, so
 * the site's languages translate it like every other interface text.
 * This file binds to that module through documented attributes; it
 * creates no text of its own.
 *
 * The contract, in full (see {@link COMMENTS_CONTRACT}):
 *
 *   [data-comments]                 the section root around all of it
 *   div[data-caelo-plugin="comments"][data-page-id="{{page.id}}"]
 *                                   the baked thread (`render.ts`); the
 *                                   placeholder is empty in the module
 *   [data-comment-older]            a button the runtime shows while older
 *                                   comments exist; one click reads a page
 *   form[data-comment-form]         the form
 *     [name="authorName"]           the name field
 *     [name="content"]              the comment field
 *     [type="submit"]               the button
 *     [data-comment-status]         the live region the outcome is
 *                                   announced in; the runtime makes it
 *                                   `role="status"` if the module did not
 *       [data-comment-sent]         hidden; shown after a comment was sent
 *       [data-comment-error]        hidden; shown when sending failed
 *
 * The two messages are elements, not attribute values: module values are
 * substituted raw (the template engine does not escape), so a site text
 * with a quote in it would break out of an attribute.
 *
 * The honeypot is the runtime's: it adds the field when the form has none,
 * and `runtime.css` keeps it off-screen. The proof-of-work for `submit` is
 * solved here too (`<challenge>|comments.submit|<nonce>`, the gateway's
 * `powPreimage`).
 *
 * ## The thread
 *
 * A long thread bakes only its newest comments, so something has to bring
 * the rest. `component.mounted` cannot: nothing mounts a plugin's Web
 * Component on a built page (#455), and this plugin no longer declares
 * one. This file reaches the browser through `buildAssets`, the channel
 * that does run. On load it asks for what was approved after the bake
 * (`since` = `data-baked-at`, CMS_REQUIREMENTS §6.1) and puts that on
 * top; the older-comments button then reads older pages on demand. The
 * button stays shut until that first read settled: it can replace the
 * thread and its cursor, and a page read from the old cursor would skip
 * what lies between. More new comments than one page means the bake is
 * far behind, so the thread is read from the top instead of merged. The
 * same path fills a placeholder nothing baked into (the editor preview).
 *
 * ## When it starts
 *
 * At DOMContentLoaded, not when the file runs. Assets load in plugin-slug
 * order, so a consent provider's runtime can come after this one, and a
 * call before it would go out without the visitor's decision: the gateway
 * takes that as "no decision" and drops the visitor id.
 *
 * ## Safety
 *
 * Visitor text only ever reaches the DOM through `textContent`. Dates are
 * formatted in `<html lang>` with the bake's options, exactly as the bake
 * did, so a comment that arrives later reads like the baked ones; a page
 * language `Intl` cannot format shows no late comments rather than dates in
 * another format (the baked ones stay). A missing piece of the contract is reported
 * to the console naming the attribute that was expected: a form that
 * quietly does nothing is the worst outcome (the plugin's write hints say
 * the same to the AI when it writes the module). Pages without a comments
 * region stop at the first line of work: this file loads on every page.
 */

import { HONEYPOT_FIELD_NAME } from "@caelo-cms/plugin-component-kit";
import { COMMENT_DATE_OPTIONS } from "./render.js";

/** The attributes and names the module and the runtime agree on. */
export const COMMENTS_CONTRACT = {
  section: "data-comments",
  older: "data-comment-older",
  form: "data-comment-form",
  status: "data-comment-status",
  sent: "data-comment-sent",
  error: "data-comment-error",
  authorField: "authorName",
  contentField: "content",
} as const;

/** The longest name `submit` accepts (the form gets it as `maxlength`). */
export const MAX_AUTHOR_LENGTH = 80;
/** The longest comment `submit` accepts. */
export const MAX_CONTENT_LENGTH = 4000;

/**
 * Behaviour CSS only — the look is the module's. The honeypot must stay
 * out of sight and out of the tab order, and `hidden` must hide the
 * older-comments button even when the site styles buttons with a
 * `display` of their own. Comment bodies keep the visitor's line breaks.
 */
export const RUNTIME_CSS =
  `[data-comments] input[name="${HONEYPOT_FIELD_NAME}"]{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;opacity:0}` +
  "[data-comments] [data-comment-older][hidden],[data-comments] form[data-comment-form][hidden]," +
  "[data-comments] [data-comment-sent][hidden],[data-comments] [data-comment-error][hidden]{display:none}" +
  "[data-comment-thread] .body{white-space:pre-wrap}";

const C = COMMENTS_CONTRACT;

/** Sent as `runtime.js` by `buildAssets`. */
export const THREAD_RUNTIME_JS = `(function () {
  "use strict";
  var regions = document.querySelectorAll('div[data-caelo-plugin="comments"][data-page-id]');
  if (regions.length === 0) return;

  var DATE_OPTIONS = ${JSON.stringify(COMMENT_DATE_OPTIONS)};
  var HONEYPOT = ${JSON.stringify(HONEYPOT_FIELD_NAME)};
  var MAX_AUTHOR = ${MAX_AUTHOR_LENGTH};
  var MAX_CONTENT = ${MAX_CONTENT_LENGTH};

  function warn(msg) {
    if (typeof console !== "undefined" && console.warn) console.warn("[caelo-comments] " + msg);
  }

  function headers(json) {
    var h = json ? { "Content-Type": "application/json" } : {};
    var consent = window.caeloConsent;
    var decision =
      consent && typeof consent.decisionHeader === "function" ? consent.decisionHeader() : null;
    if (decision) h["x-caelo-consent"] = decision;
    return h;
  }

  function call(operation, body) {
    return fetch("/api/plugin/comments/" + operation, {
      method: "POST",
      headers: headers(true),
      credentials: "same-origin",
      body: JSON.stringify(body),
    }).then(function (res) { return res.json(); });
  }

  function read(args) {
    return call("list_approved", args).then(function (json) {
      if (!json.ok || !json.data) throw new Error("list_approved was refused");
      return json.data;
    });
  }

  function hex(buf) {
    return Array.prototype.map
      .call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, "0"); })
      .join("");
  }

  // The gateway's proof-of-work, bound to comments.submit (#1332). 204 =
  // the Owner turned the captcha off: no proof.
  function proof() {
    return fetch("/api/captcha/challenge", { credentials: "same-origin", headers: headers(false) })
      .then(function (res) {
        if (res.status === 204) return null;
        if (!res.ok) throw new Error("captcha challenge " + res.status);
        return res.json().then(function (env) {
          if (!env.ok || !env.data) throw new Error("captcha challenge malformed");
          return solve(env.data.challenge, env.data.target);
        });
      });
  }

  function solve(challenge, target) {
    var enc = new TextEncoder();
    var n = 0;
    function next() {
      if (n > 5000000) throw new Error("proof-of-work exceeded its budget");
      var nonce = n.toString(16);
      n += 1;
      return crypto.subtle
        .digest("SHA-256", enc.encode(challenge + "|comments.submit|" + nonce))
        .then(function (d) {
          return hex(d).indexOf(target) === 0 ? { challenge: challenge, nonce: nonce } : next();
        });
    }
    return next();
  }

  // The bake formats in <html lang> (the page's document language); so does
  // this, whatever lang a module around the region carries.
  function dateFormat() {
    var lang = document.documentElement.getAttribute("lang") || "";
    try {
      return new Intl.DateTimeFormat(lang, DATE_OPTIONS);
    } catch (e) {
      warn("the page language '" + lang + "' cannot format dates, so no comment newer than the page is shown");
      return null;
    }
  }

  function articleOf(c, day) {
    var at = new Date(c.submitted_at);
    var article = document.createElement("article");
    article.className = "comment";
    article.setAttribute("data-comment-id", c.id);
    var header = document.createElement("header");
    var author = document.createElement("span");
    author.className = "comment-author";
    author.textContent = c.author_name;
    var time = document.createElement("time");
    time.setAttribute("datetime", at.toISOString());
    time.textContent = day.format(at);
    header.appendChild(author);
    header.appendChild(document.createTextNode(" "));
    header.appendChild(time);
    var body = document.createElement("div");
    body.className = "body";
    body.textContent = c.content;
    article.appendChild(header);
    article.appendChild(body);
    return article;
  }

  function mountThread(region, section, pageId) {
    var bakedAt = region.getAttribute("data-baked-at");
    var day = dateFormat();
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
    var cursorAttr = thread.getAttribute("data-cursor");
    var cursor = cursorAttr ? JSON.parse(cursorAttr) : null;
    var button = section ? section.querySelector("[${C.older}]") : null;
    var warnedNoButton = false;
    if (button) button.addEventListener("click", showOlder);

    function syncButton(settled) {
      if (!button) {
        if (cursor && !warnedNoButton) {
          warnedNoButton = true;
          warn("older comments exist on this page, but its comments section has no [${C.older}] button to show them");
        }
        return;
      }
      button.hidden = !cursor;
      button.disabled = !settled;
    }

    function add(comments, onTop) {
      if (!day) return;
      var fresh = comments.filter(function (c) { return !seen[c.id]; });
      if (onTop) fresh.reverse();
      fresh.forEach(function (c) {
        seen[c.id] = true;
        var article = articleOf(c, day);
        if (onTop) thread.insertBefore(article, thread.firstChild);
        else thread.appendChild(article);
      });
    }

    function showOlder() {
      if (!cursor || button.disabled) return;
      button.disabled = true;
      read({ pageId: pageId, before: cursor })
        .then(function (page) {
          add(page.comments, false);
          cursor = page.nextCursor;
          syncButton(true);
        })
        .catch(function (e) {
          warn("could not load older comments: " + e);
          button.disabled = false;
        });
    }

    function readFromTop() {
      return read({ pageId: pageId }).then(function (page) {
        thread.textContent = "";
        seen = {};
        add(page.comments, false);
        cursor = page.nextCursor;
      });
    }

    syncButton(false);
    var first = bakedAt
      ? read({ pageId: pageId, since: bakedAt }).then(function (page) {
          if (page.nextCursor) return readFromTop();
          add(page.comments, true);
        })
      : readFromTop();
    first
      .catch(function (e) {
        warn("could not read new comments: " + e);
      })
      .then(function () { syncButton(true); });
  }

  function mountForm(form, pageId) {
    var author = form.querySelector('[name="${C.authorField}"]');
    var content = form.querySelector('[name="${C.contentField}"]');
    var submit = form.querySelector('[type="submit"]');
    var status = form.querySelector("[${C.status}]");
    var sent = status ? status.querySelector("[${C.sent}]") : null;
    var failed = status ? status.querySelector("[${C.error}]") : null;
    var missing = [];
    if (!author) missing.push('[name="${C.authorField}"]');
    if (!content) missing.push('[name="${C.contentField}"]');
    if (!submit) missing.push('[type="submit"]');
    if (!status) missing.push("[${C.status}]");
    if (!sent) missing.push("[${C.sent}] inside [${C.status}]");
    if (!failed) missing.push("[${C.error}] inside [${C.status}]");
    // Never let the browser send the form itself: it would put the comment
    // in the page's address and reach no one.
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (missing.length > 0) {
        warn("the comment form cannot send: it lacks " + missing.join(", "));
        return;
      }
      if (typeof form.reportValidity === "function" && !form.reportValidity()) return;
      send();
    });
    if (missing.length > 0) {
      warn("the comment form lacks " + missing.join(", ") + "; visitors cannot send comments");
      return;
    }
    if (!form.querySelector('[name="' + HONEYPOT + '"]')) {
      var trap = document.createElement("input");
      trap.setAttribute("name", HONEYPOT);
      trap.setAttribute("tabindex", "-1");
      trap.setAttribute("autocomplete", "off");
      trap.setAttribute("aria-hidden", "true");
      form.appendChild(trap);
    }
    // The outcome must reach screen readers too, whatever the module wrote.
    if (!status.getAttribute("role")) status.setAttribute("role", "status");
    if (!status.getAttribute("aria-live")) status.setAttribute("aria-live", "polite");
    sent.hidden = true;
    failed.hidden = true;
    if (!(author.maxLength > 0 && author.maxLength <= MAX_AUTHOR)) author.maxLength = MAX_AUTHOR;
    if (!(content.maxLength > 0 && content.maxLength <= MAX_CONTENT)) content.maxLength = MAX_CONTENT;
    form.hidden = false;

    // Only the hidden flags change: the messages are the module's own
    // elements, in the site's words, and the live region announces the one
    // that appears.
    function announce(state) {
      if (state) status.setAttribute("data-state", state);
      else status.removeAttribute("data-state");
      sent.hidden = state !== "sent";
      failed.hidden = state !== "error";
    }

    function send() {
      submit.disabled = true;
      form.setAttribute("aria-busy", "true");
      announce(null);
      var trapField = form.querySelector('[name="' + HONEYPOT + '"]');
      var body = {
        pageId: pageId,
        authorName: author.value,
        content: content.value,
      };
      body[HONEYPOT] = trapField ? trapField.value : "";
      proof()
        .then(function (p) {
          if (p) body._caelo_captcha = p;
          return call("submit", body);
        })
        .then(function (json) {
          if (!json.ok) throw new Error((json.error && json.error.kind) || "refused");
          announce("sent");
          form.reset();
        })
        .catch(function (e) {
          warn("the comment was not sent: " + e);
          announce("error");
        })
        .then(function () {
          submit.disabled = false;
          form.removeAttribute("aria-busy");
        });
    }
  }

  function mount(region) {
    var pageId = region.getAttribute("data-page-id");
    var section = region.closest("[${C.section}]");
    if (!section) {
      warn("the comments of page " + pageId + " sit in no [${C.section}] section, so they have no form and no button for older comments");
    }
    mountThread(region, section, pageId);
    var form = section ? section.querySelector("form[${C.form}]") : null;
    if (section && !form) warn("the comments section of page " + pageId + " has no form[${C.form}]; visitors cannot comment");
    if (form) mountForm(form, pageId);
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
