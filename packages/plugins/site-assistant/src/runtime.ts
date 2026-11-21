// SPDX-License-Identifier: MPL-2.0

/**
 * The site assistant's browser side (issue #1655), shipped as a client
 * asset on every page. It binds to markup the AI writes into one of the
 * site's own modules, so the launcher looks like the site and every text
 * is the site's (`{{site_text.*}}`, translated with it):
 *
 *   <div data-caelo-assistant>
 *     <button type="button" data-caelo-assistant-open aria-haspopup="dialog">Fragen?</button>
 *     <template data-caelo-assistant-texts>
 *       <span data-text="title">Fragen zur Website</span>
 *       <span data-text="greeting">Ich beantworte Fragen aus den Seiten dieser Website.</span>
 *       <span data-text="disclosure">Antworten schreibt eine KI …</span>
 *       <a data-text="privacy" href="/datenschutz/">Datenschutz</a>
 *       <a data-text="handoff" href="/kontakt/">Kontakt</a>
 *       <span data-text="placeholder">Ihre Frage</span> … (skills.ts lists them all)
 *     </template>
 *     <div data-caelo-plugin="site-assistant" data-page-id="…"></div>
 *   </div>
 *
 * Until the visitor opens it, the launcher is the site's static button and
 * nothing is fetched. Opening it mounts `<caelo-assistant>`, a Web Component
 * in Shadow DOM: a non-modal dialog with the AI disclosure, the privacy
 * link, the conversation in a live region (`role="log"`, busy while an
 * answer streams), the question field and, when the Owner turned feedback
 * on, rating buttons. Escape closes it and returns focus to the launcher.
 *
 * The answer streams from the gateway (`streamOrigin` of the info call,
 * the site's own origin elsewhere) and is rendered as text; `[n]` becomes a
 * link only to a source the gateway sent (widget-logic.ts). The signed
 * history stays in this tab (sessionStorage), never on a server. A
 * conversation starts with the gateway's proof of work. Requests send no
 * cookie (`credentials: "omit"`). Nothing here builds site content: the
 * texts are cloned from the markup, the rest is the conversation itself.
 */

import { WIDGET_LOGIC } from "./widget-logic.js";

const LOGIC = WIDGET_LOGIC.map((f) => f.toString()).join("\n");

const MAIN = String.raw`
  var SLUG = "site-assistant";
  var OP = "ask";
  var API = "/api/plugin/" + SLUG + "/";
  var STORE = "caelo-assistant";
  var info = null;
  var infoAsked = null;

  function lang() {
    var l = (document.documentElement.getAttribute("lang") || "").toLowerCase();
    return /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/.test(l) ? l : "en";
  }

  function load() {
    try {
      var raw = sessionStorage.getItem(STORE);
      var v = raw ? JSON.parse(raw) : null;
      if (v && Array.isArray(v.history) && Array.isArray(v.messages)) return v;
    } catch (e) {}
    return { history: [], messages: [] };
  }
  function save(state) {
    try { sessionStorage.setItem(STORE, JSON.stringify(state)); } catch (e) {}
  }

  function hex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) {
      return b.toString(16).padStart(2, "0");
    }).join("");
  }

  function proof(scope) {
    return fetch("/api/captcha/challenge?for=" + encodeURIComponent(scope), { credentials: "omit" })
      .then(function (res) {
        if (res.status === 204) return null;
        if (!res.ok) throw new Error("challenge " + res.status);
        return res.json().then(function (env) {
          var enc = new TextEncoder();
          var n = 0;
          function next() {
            if (n > 5000000) throw new Error("proof-of-work exceeded its budget");
            var nonce = n.toString(16);
            n += 1;
            return crypto.subtle
              .digest("SHA-256", enc.encode(env.data.challenge + "|" + scope + "|" + nonce))
              .then(function (d) {
                return hex(d).indexOf(env.data.target) === 0
                  ? { challenge: env.data.challenge, nonce: nonce }
                  : next();
              });
          }
          return next();
        });
      });
  }

  function getInfo() {
    if (info) return Promise.resolve(info);
    if (infoAsked) return infoAsked;
    infoAsked = fetch(API + OP, { credentials: "omit" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (body) {
        info = body && body.data ? body.data : { available: false };
        return info;
      })
      .catch(function () { infoAsked = null; return { available: false }; });
    return infoAsked;
  }

  // The settings the plugin renders into its placeholder: whether feedback is kept.
  function feedbackOn(root) {
    var s = (root || document).querySelector("[data-caelo-assistant-settings]") ||
      document.querySelector("[data-caelo-assistant-settings]");
    return s !== null && s.getAttribute("data-feedback") === "on";
  }

  function sendFeedback(kind, question, note) {
    return proof(SLUG + ".feedback").then(function (p) {
      var body = { kind: kind, lang: lang(), website: "" };
      if (question) body.question = question.slice(0, 500);
      if (note) body.note = note.slice(0, 500);
      if (p) body._caelo_captcha = p;
      return fetch(API + "feedback", {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }).catch(function () {});
  }

  var CSS = [
    ":host{position:fixed;inset:auto 1rem 1rem auto;z-index:2147483000;width:min(26rem,calc(100vw - 2rem));max-height:min(36rem,calc(100vh - 2rem));display:flex;flex-direction:column;font:inherit;color:var(--caelo-color-text,#111);background:var(--caelo-color-surface,#fff);border:1px solid var(--caelo-color-border,#d4d4d8);border-radius:.75rem;box-shadow:0 10px 30px rgba(0,0,0,.18)}",
    "@media (max-width:30rem){:host{inset:auto .5rem .5rem .5rem;width:auto}}",
    "header{display:flex;align-items:center;justify-content:space-between;gap:.5rem;padding:.75rem 1rem;border-bottom:1px solid var(--caelo-color-border,#e4e4e7)}",
    "h2{font-size:1rem;margin:0}",
    "button{font:inherit;cursor:pointer;border-radius:.5rem;border:1px solid var(--caelo-color-border,#d4d4d8);background:transparent;color:inherit;padding:.35rem .7rem}",
    "button[data-primary]{background:var(--caelo-color-primary,#1d4ed8);border-color:transparent;color:var(--caelo-color-on-primary,#fff)}",
    "button:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid var(--caelo-color-primary,#1d4ed8);outline-offset:2px}",
    "[role=log]{flex:1;overflow:auto;padding:.75rem 1rem;display:flex;flex-direction:column;gap:.75rem}",
    ".q{align-self:flex-end;background:var(--caelo-color-muted-surface,#f4f4f5);border-radius:.75rem;padding:.5rem .75rem;max-width:85%}",
    ".a{white-space:pre-wrap;line-height:1.5}",
    ".a a{color:var(--caelo-color-primary,#1d4ed8)}",
    ".sources{font-size:.85rem;margin:.35rem 0 0;padding-left:1.1rem}",
    ".rate{display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.4rem}",
    ".note{display:flex;gap:.4rem;margin-top:.4rem}",
    ".note input{flex:1;font:inherit;padding:.3rem .5rem}",
    ".meta,.notice{font-size:.8rem;color:var(--caelo-color-muted,#52525b);padding:0 1rem}",
    ".notice a{color:inherit}",
    "form{display:flex;gap:.5rem;padding:.75rem 1rem;border-top:1px solid var(--caelo-color-border,#e4e4e7)}",
    "textarea{flex:1;font:inherit;resize:none;min-height:2.5rem;padding:.4rem .6rem;border-radius:.5rem;border:1px solid var(--caelo-color-border,#d4d4d8)}",
    "[hidden]{display:none!important}",
  ].join("");

  function texts(scope) {
    var out = {};
    var tpl = scope.querySelector("template[data-caelo-assistant-texts]");
    if (!tpl) return out;
    var els = tpl.content.querySelectorAll("[data-text]");
    for (var i = 0; i < els.length; i++) out[els[i].getAttribute("data-text")] = els[i];
    return out;
  }
  function textOf(t, key) { return t[key] ? t[key].textContent.trim() : ""; }
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }

  class Assistant extends HTMLElement {}

  Assistant.prototype.mount = function (scope, launcher) {
    var self = this;
    var t = texts(scope);
    var root = this.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);
    var titleId = "caelo-assistant-title";
    this.setAttribute("role", "dialog");
    this.setAttribute("aria-labelledby", titleId);
    var header = el("header");
    var h = el("h2", { id: titleId }, textOf(t, "title"));
    var close = el("button", { type: "button", "aria-label": textOf(t, "close") || "×" }, "×");
    header.appendChild(h);
    header.appendChild(close);
    var notice = el("p", { class: "notice" });
    if (t.disclosure) notice.appendChild(document.createTextNode(textOf(t, "disclosure") + " "));
    if (t.privacy && t.privacy.getAttribute("href")) {
      notice.appendChild(el("a", { href: t.privacy.getAttribute("href") }, textOf(t, "privacy")));
    }
    var log = el("div", { role: "log", "aria-live": "polite", "aria-relevant": "additions text" });
    var status = el("p", { class: "meta", role: "status", "aria-live": "polite" });
    var form = el("form");
    var input = el("textarea", { rows: "2", "aria-label": textOf(t, "placeholder"), placeholder: textOf(t, "placeholder") });
    var send = el("button", { type: "submit", "data-primary": "" }, textOf(t, "send"));
    var restart = el("button", { type: "button", hidden: "" }, textOf(t, "new"));
    form.appendChild(input);
    form.appendChild(send);
    root.appendChild(header);
    root.appendChild(notice);
    root.appendChild(log);
    root.appendChild(status);
    root.appendChild(form);
    root.appendChild(restart);

    var state = load();
    var busy = false;

    function say(text) { status.textContent = text || ""; }
    function handoff(parent) {
      if (t.handoff && t.handoff.getAttribute("href")) {
        var p = el("p", { class: "a" });
        p.appendChild(el("a", { href: t.handoff.getAttribute("href") }, textOf(t, "handoff")));
        parent.appendChild(p);
      }
    }
    function renderAnswer(box, text, sources) {
      box.textContent = "";
      var parts = answerParts(text, sources);
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i];
        if (part.text != null) box.appendChild(document.createTextNode(part.text));
        else box.appendChild(el("a", { href: part.href, title: part.title }, "[" + part.cite + "]"));
      }
      var cited = (sources || []).filter(function (s) { return s.cited && sourceHref(s); });
      if (cited.length > 0) {
        var list = el("ol", { class: "sources", "aria-label": textOf(t, "sources") || null });
        cited.forEach(function (s) {
          var li = el("li");
          li.appendChild(el("a", { href: sourceHref(s) }, s.title || sourceHref(s)));
          list.appendChild(li);
        });
        box.appendChild(list);
      }
    }
    function rating(box, question, sources) {
      if (!feedbackOn(scope)) return;
      if (!answered(sources)) {
        // An answer without a source: the site may lack the page.
        sendFeedback("unanswered", question, null);
        return;
      }
      var row = el("div", { class: "rate" });
      var up = el("button", { type: "button", "aria-pressed": "false" }, textOf(t, "helpful"));
      var down = el("button", { type: "button", "aria-pressed": "false" }, textOf(t, "not_helpful"));
      row.appendChild(up);
      row.appendChild(down);
      box.appendChild(row);
      function done() { row.textContent = textOf(t, "thanks"); }
      up.addEventListener("click", function () { sendFeedback("helpful", null, null); done(); });
      down.addEventListener("click", function () {
        row.textContent = "";
        var f = el("form", { class: "note" });
        var note = el("input", { type: "text", maxlength: "500", "aria-label": textOf(t, "note"), placeholder: textOf(t, "note") });
        var ok = el("button", { type: "submit" }, textOf(t, "send"));
        f.appendChild(note);
        f.appendChild(ok);
        row.appendChild(f);
        note.focus();
        f.addEventListener("submit", function (ev) {
          ev.preventDefault();
          sendFeedback("not_helpful", question, note.value.trim() || null);
          done();
        });
      });
    }
    function addQuestion(text) { log.appendChild(el("div", { class: "q" }, text)); }
    function addAnswer() {
      var box = el("div", { class: "a" });
      log.appendChild(box);
      return box;
    }
    function full(limits) {
      var max = limits && limits.maxTurns ? limits.maxTurns : 8;
      if (conversationFull(state.history, max)) {
        input.disabled = true;
        send.disabled = true;
        restart.hidden = false;
        say(textOf(t, "limit"));
        return true;
      }
      return false;
    }

    // What this tab already asked, shown again.
    if (state.messages.length === 0 && t.greeting) log.appendChild(el("div", { class: "a" }, textOf(t, "greeting")));
    state.messages.forEach(function (m) {
      addQuestion(m.q);
      renderAnswer(addAnswer(), m.a, m.sources);
    });

    getInfo().then(function (i) {
      if (!i || !i.available) {
        input.disabled = true;
        send.disabled = true;
        say(textOf(t, "unavailable"));
        handoff(log);
        return;
      }
      full(i.limits);
    });

    restart.addEventListener("click", function () {
      state = { history: [], messages: [] };
      save(state);
      log.textContent = "";
      if (t.greeting) log.appendChild(el("div", { class: "a" }, textOf(t, "greeting")));
      input.disabled = false;
      send.disabled = false;
      restart.hidden = true;
      say("");
      input.focus();
    });

    function ask(question, i) {
      busy = true;
      send.disabled = true;
      log.setAttribute("aria-busy", "true");
      addQuestion(question);
      var box = addAnswer();
      var text = "";
      var sources = [];
      var first = state.history.length === 0;
      var origin = i.streamOrigin || "";
      (first ? proof(SLUG + "." + OP) : Promise.resolve(null))
        .then(function (p) {
          var body = { question: question, lang: lang(), history: state.history };
          if (p) body.captcha = p;
          return fetch(origin + API + OP, {
            method: "POST",
            credentials: "omit",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        })
        .then(function (res) {
          if (!res.body) throw new Error("no stream");
          var reader = res.body.getReader();
          var dec = new TextDecoder();
          var buffer = "";
          function pump() {
            return reader.read().then(function (r) {
              if (r.done) return;
              buffer += dec.decode(r.value, { stream: true });
              var parsed = parseSse(buffer);
              buffer = parsed.rest;
              for (var k = 0; k < parsed.events.length; k++) {
                var ev = parsed.events[k];
                if (ev.event === "delta" && ev.data && typeof ev.data.text === "string") {
                  text += ev.data.text;
                  box.textContent = text;
                } else if (ev.event === "sources" && ev.data && Array.isArray(ev.data.sources)) {
                  sources = ev.data.sources;
                } else if (ev.event === "done" && ev.data) {
                  state.history = appendTurn(state.history, ev.data.turn);
                  state.messages = state.messages.concat([{ q: question, a: text, sources: sources }]);
                  save(state);
                  renderAnswer(box, text, sources);
                  rating(box, question, sources);
                  if (ev.data.conversation) say(ev.data.conversation.turn + " / " + ev.data.conversation.maxTurns);
                  full(i.limits);
                } else if (ev.event === "error" && ev.data) {
                  var kind = ev.data.kind;
                  box.textContent = textOf(t, kind === "BudgetExhausted" ? "budget" : kind === "TooLong" ? "toolong" : kind === "Unavailable" ? "unavailable" : "error") || String(ev.data.message || "");
                  if (kind === "Invalid") { state = { history: [], messages: [] }; save(state); }
                  if (kind === "BudgetExhausted" || kind === "Unavailable") handoff(box);
                }
              }
              return pump();
            });
          }
          return pump();
        })
        .catch(function () { box.textContent = textOf(t, "error"); handoff(box); })
        .then(function () {
          busy = false;
          log.setAttribute("aria-busy", "false");
          if (!input.disabled) send.disabled = false;
          log.scrollTop = log.scrollHeight;
        });
    }

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (busy) return;
      getInfo().then(function (i) {
        if (!i || !i.available) return;
        var max = i.limits && i.limits.maxQuestionChars ? i.limits.maxQuestionChars : 500;
        var q = checkQuestion(input.value, max);
        if (q === null) { say(input.value.trim() === "" ? "" : textOf(t, "toolong")); return; }
        if (full(i.limits)) return;
        input.value = "";
        say("");
        ask(q, i);
      });
    });
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); form.requestSubmit(); }
    });
    function closeIt() {
      self.remove();
      launcher.setAttribute("aria-expanded", "false");
      launcher.focus();
    }
    close.addEventListener("click", closeIt);
    root.addEventListener("keydown", function (ev) { if (ev.key === "Escape") closeIt(); });
    setTimeout(function () { input.focus(); }, 0);
  };

  if (!customElements.get("caelo-assistant")) customElements.define("caelo-assistant", Assistant);

  function bind(scope) {
    var launcher = scope.querySelector("[data-caelo-assistant-open]");
    if (!launcher || launcher.__caeloAssistant) return;
    launcher.__caeloAssistant = true;
    launcher.setAttribute("aria-expanded", "false");
    launcher.addEventListener("click", function () {
      var open = document.querySelector("caelo-assistant");
      if (open) { open.remove(); launcher.setAttribute("aria-expanded", "false"); return; }
      var panel = document.createElement("caelo-assistant");
      document.body.appendChild(panel);
      panel.mount(scope, launcher);
      launcher.setAttribute("aria-expanded", "true");
    });
  }

  function start() {
    var scopes = document.querySelectorAll("[data-caelo-assistant]");
    for (var i = 0; i < scopes.length; i++) bind(scopes[i]);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
`;

/** The browser script: the widget logic (widget-logic.ts) and the binding. */
export const RUNTIME_JS = `(function () {\n"use strict";\n${LOGIC}\n${MAIN}\n})();\n`;
