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
 * conversation starts with the gateway's proof of work. Requests carry the
 * page's own credentials only (`credentials: "same-origin"`): on staging the
 * gate admits only the operator's staging cookie, and a cross-origin stream
 * (run.app on gcp-firebase) carries none. Nothing here builds site content: the
 * texts are cloned from the markup, the rest is the conversation itself.
 *
 * #1701 — the inline answer: on the search results page the site places
 * its own answer card, and the visitor's search query is asked once, as
 * the question, with no launcher and no floating panel:
 *
 *   <section data-caelo-assistant-answer hidden>
 *     <p><span data-caelo-assistant-disclosure>Antworten schreibt eine KI …</span> <a href="/datenschutz/">…</a></p>
 *     <div data-caelo-assistant-thread></div>
 *     <template data-caelo-assistant-turn>
 *       <article><p data-field="question"></p><div data-field="answer"></div>
 *         <ol data-field="sources"></ol>
 *         <div data-field="rating" hidden><button data-rate="helpful">…</button>
 *           <button data-rate="not_helpful">…</button></div></article>
 *     </template>
 *     <template data-caelo-assistant-source><li><a data-field="link"><span data-field="title"></span></a></li></template>
 *     <p data-caelo-assistant-status role="status"></p>
 *     <form data-caelo-assistant-followup hidden><input data-caelo-assistant-input>…</form>
 *     <template data-caelo-assistant-texts>… (thinking, thanks, errors, handoff)</template>
 *   </section>
 *
 * It follows site-search's precedent (the results page fills the site's
 * hit template): the runtime fills the site's templates in the page
 * itself, so the card is the site's markup, CSS and texts; it is no Web
 * Component, and the widget keeps its Shadow DOM. The query comes from the
 * address as site-search reads it (`#q=` first, then `?q=`, again on
 * `hashchange`); an answer stays in the tab per query, so a reload asks
 * nothing again. The same conversation, limits, proof of work and feedback
 * as the widget; without a non-empty disclosure element nothing is asked.
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
    return fetch("/api/captcha/challenge?for=" + encodeURIComponent(scope), { credentials: "same-origin" })
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
    infoAsked = fetch(API + OP, { credentials: "same-origin" })
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
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }).catch(function () {});
  }

  // One question to the conversation, streamed: the widget and the inline
  // answer share it. The first question of a conversation solves the proof
  // of work; each event goes to its handler. The signal stops a stream whose
  // answer nobody shows any more (a new query on the results page).
  function streamAnswer(i, question, history, signal, on) {
    var first = history.length === 0;
    var origin = i.streamOrigin || "";
    return (first ? proof(SLUG + "." + OP) : Promise.resolve(null))
      .then(function (p) {
        var body = { question: question, lang: lang(), history: history };
        if (p) body.captcha = p;
        var init = {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        };
        if (signal) init.signal = signal;
        return fetch(origin + API + OP, init);
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
              if (ev.event === "delta" && ev.data && typeof ev.data.text === "string") on.delta(ev.data.text);
              else if (ev.event === "sources" && ev.data && Array.isArray(ev.data.sources)) on.sources(ev.data.sources);
              else if (ev.event === "done" && ev.data) on.done(ev.data);
              else if (ev.event === "error" && ev.data) on.error(ev.data.kind, ev.data.message);
            }
            return pump();
          });
        }
        return pump();
      });
  }

  // The site text an error the gateway sends is told with.
  function errorKey(kind) {
    return kind === "BudgetExhausted" ? "budget" : kind === "TooLong" ? "toolong" : kind === "Unavailable" ? "unavailable" : "error";
  }

  var CSS = [
    ":host{position:fixed;inset:auto 1rem 1rem auto;z-index:2147483000;width:min(26rem,calc(100vw - 2rem));font:inherit}",
    ".box{max-height:min(36rem,calc(100vh - 2rem));display:flex;flex-direction:column;color:var(--caelo-color-text,#111);background:var(--caelo-color-surface,#fff);border:1px solid var(--caelo-color-border,#d4d4d8);border-radius:.75rem;box-shadow:0 10px 30px rgba(0,0,0,.18)}",
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
    // The dialog and its label live in one root: a label reference does not
    // cross the shadow boundary.
    var titleId = "caelo-assistant-title";
    var box = el("div", { class: "box", role: "dialog", "aria-modal": "false", "aria-labelledby": titleId });
    root.appendChild(box);
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
    box.appendChild(header);
    box.appendChild(notice);
    box.appendChild(log);
    box.appendChild(status);
    box.appendChild(form);
    box.appendChild(restart);

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
      streamAnswer(i, question, state.history, null, {
        delta: function (d) {
          text += d;
          box.textContent = text;
        },
        sources: function (s) { sources = s; },
        done: function (data) {
          state.history = appendTurn(state.history, data.turn);
          state.messages = state.messages.concat([{ q: question, a: text, sources: sources }]);
          save(state);
          renderAnswer(box, text, sources);
          rating(box, question, sources);
          if (data.conversation) say(data.conversation.turn + " / " + data.conversation.maxTurns);
          full(i.limits);
        },
        error: function (kind, message) {
          box.textContent = textOf(t, errorKey(kind)) || String(message || "");
          if (kind === "Invalid") { state = { history: [], messages: [] }; save(state); }
          if (kind === "BudgetExhausted" || kind === "Unavailable") handoff(box);
        },
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
    // The panel is in the document already: the focus moves at once, so a
    // key pressed right after opening reaches it.
    input.focus();
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

  // ---- the inline answer (#1701) ----
  var ANSWER_STORE = "caelo-assistant-answer";

  function loadAnswer() {
    try {
      var raw = sessionStorage.getItem(ANSWER_STORE);
      var v = raw ? JSON.parse(raw) : null;
      if (v && typeof v.query === "string" && Array.isArray(v.history) && Array.isArray(v.messages)) return v;
    } catch (e) {}
    return null;
  }
  function saveAnswer(state) {
    try { sessionStorage.setItem(ANSWER_STORE, JSON.stringify(state)); } catch (e) {}
  }

  function bindAnswer(root) {
    if (root.__caeloAnswer) return;
    root.__caeloAnswer = true;
    var t = texts(root);
    var thread = root.querySelector("[data-caelo-assistant-thread]");
    var turnTpl = root.querySelector("template[data-caelo-assistant-turn]");
    var sourceTpl = root.querySelector("template[data-caelo-assistant-source]");
    var status = root.querySelector("[data-caelo-assistant-status]");
    var followup = root.querySelector("form[data-caelo-assistant-followup]");
    var input = followup ? (followup.querySelector("[data-caelo-assistant-input]") || followup.querySelector("input, textarea")) : null;
    var disclosure = root.querySelector("[data-caelo-assistant-disclosure]");
    if (!thread || !turnTpl) {
      root.setAttribute("data-caelo-assistant-state", "markup-missing");
      return;
    }
    // Visitors are told an AI writes the answer, always: no disclosure, no question.
    if (!disclosure || disclosure.textContent.trim() === "") {
      root.setAttribute("data-caelo-assistant-state", "disclosure-missing");
      return;
    }
    var query = "";
    var state = null;
    var busy = false;
    // The ask the card shows; a newer query stops the older one's stream.
    var gen = 0;
    var running = null;

    function setState(v) { root.setAttribute("data-caelo-assistant-state", v); }
    function say(key) { if (status) status.textContent = key ? textOf(t, key) : ""; }
    function handoff(parent) {
      if (t.handoff && t.handoff.getAttribute("href")) {
        var p = el("p");
        p.appendChild(el("a", { href: t.handoff.getAttribute("href") }, textOf(t, "handoff")));
        parent.appendChild(p);
      }
    }

    // One turn from the site's template: its fields by name.
    function addTurn(question) {
      var node = turnTpl.content.cloneNode(true);
      var parts = {};
      var fields = node.querySelectorAll("[data-field]");
      for (var k = 0; k < fields.length; k++) parts[fields[k].getAttribute("data-field")] = fields[k];
      if (parts.question) parts.question.textContent = question;
      thread.appendChild(node);
      return parts;
    }

    function fill(parts, text, sources) {
      if (parts.answer) {
        parts.answer.textContent = "";
        var pieces = answerParts(text, sources);
        for (var k = 0; k < pieces.length; k++) {
          var piece = pieces[k];
          if (piece.text != null) parts.answer.appendChild(document.createTextNode(piece.text));
          else parts.answer.appendChild(el("a", { href: piece.href, title: piece.title }, "[" + piece.cite + "]"));
        }
      }
      if (!parts.sources) return;
      parts.sources.textContent = "";
      var cited = (sources || []).filter(function (s) { return s.cited && sourceHref(s); });
      cited.forEach(function (s) {
        var href = sourceHref(s);
        if (!sourceTpl) {
          var li = el("li");
          li.appendChild(el("a", { href: href }, s.title || href));
          parts.sources.appendChild(li);
          return;
        }
        var node = sourceTpl.content.cloneNode(true);
        var fields = node.querySelectorAll("[data-field]");
        for (var k = 0; k < fields.length; k++) {
          var f = fields[k].getAttribute("data-field");
          if (f === "link") fields[k].setAttribute("href", href);
          else if (f === "title") fields[k].textContent = s.title || href;
          else if (f === "n") fields[k].textContent = String(s.n);
          else if (f === "url") fields[k].textContent = href;
        }
        parts.sources.appendChild(node);
      });
      parts.sources.hidden = cited.length === 0;
    }

    function rate(parts, question, sources) {
      var box = parts.rating;
      if (!feedbackOn(root)) { if (box) box.hidden = true; return; }
      if (!answered(sources)) {
        // An answer without a source: the site may lack the page.
        sendFeedback("unanswered", question, null);
        if (box) box.hidden = true;
        return;
      }
      if (!box) return;
      box.hidden = false;
      var up = box.querySelector('[data-rate="helpful"]');
      var down = box.querySelector('[data-rate="not_helpful"]');
      var note = parts.note;
      function done() { box.textContent = textOf(t, "thanks"); }
      if (up) up.addEventListener("click", function () { sendFeedback("helpful", null, null); done(); });
      var field = note ? note.querySelector("input, textarea") : null;
      if (note) note.addEventListener("submit", function (ev) {
        ev.preventDefault();
        sendFeedback("not_helpful", question, field && field.value.trim() ? field.value.trim() : null);
        done();
      });
      if (down) down.addEventListener("click", function () {
        if (!note) { sendFeedback("not_helpful", question, null); done(); return; }
        note.hidden = false;
        if (field) field.focus();
      });
    }

    function followUp(i) {
      if (!followup || !input) return;
      followup.hidden = false;
      var max = i.limits && i.limits.maxTurns ? i.limits.maxTurns : 8;
      var used = conversationFull(state.history, max);
      input.disabled = used;
      var submit = followup.querySelector('[type="submit"]');
      if (submit) submit.disabled = used || busy;
      if (used) say("limit");
    }

    function ask(question, i) {
      var mine = ++gen;
      busy = true;
      if (running) running.abort();
      running = typeof AbortController === "function" ? new AbortController() : null;
      var parts = addTurn(question);
      var text = "";
      var sources = [];
      setState("loading");
      thread.setAttribute("aria-busy", "true");
      say("thinking");
      return streamAnswer(i, question, state.history, running ? running.signal : null, {
        delta: function (d) {
          if (mine !== gen) return;
          text += d;
          if (parts.answer) parts.answer.textContent = text;
        },
        sources: function (s) { if (mine === gen) sources = s; },
        done: function (data) {
          if (mine !== gen) return;
          state.history = appendTurn(state.history, data.turn);
          state.messages = state.messages.concat([{ q: question, a: text, sources: sources }]);
          saveAnswer(state);
          fill(parts, text, sources);
          rate(parts, question, sources);
          setState("done");
          say("");
        },
        error: function (kind, message) {
          if (mine !== gen) return;
          if (parts.answer) {
            parts.answer.textContent = textOf(t, errorKey(kind)) || String(message || "");
            if (kind === "BudgetExhausted" || kind === "Unavailable") handoff(parts.answer);
          }
          if (kind === "Invalid") {
            state = { query: query, history: [], messages: [] };
            saveAnswer(state);
          }
          setState("error");
          say("");
        },
      })
        .catch(function () {
          if (mine !== gen) return;
          if (parts.answer) {
            parts.answer.textContent = textOf(t, "error");
            handoff(parts.answer);
          }
          setState("error");
          say("");
        })
        .then(function () {
          if (mine !== gen) return;
          busy = false;
          running = null;
          thread.setAttribute("aria-busy", "false");
          followUp(i);
        });
    }

    // The query of the address: on load, and whenever the fragment changes
    // (site-search's hash mode). Asked once per query; this tab keeps the
    // answer, so the same query shows it again without asking.
    function follow(isChange) {
      var found = searchQueryOf(location.search, location.hash);
      if (isChange && found.anchor) return;
      if (found.query === query) return;
      query = found.query;
      gen += 1;
      if (running) { running.abort(); running = null; }
      busy = false;
      thread.textContent = "";
      say("");
      if (followup) followup.hidden = true;
      if (query === "") {
        root.hidden = true;
        setState("idle");
        return;
      }
      getInfo().then(function (i) {
        if (found.query !== query) return;
        var max = i && i.limits && i.limits.maxQuestionChars ? i.limits.maxQuestionChars : 500;
        if (!i || !i.available || checkQuestion(query, max) === null) {
          // No card rather than a broken one: the results stand alone.
          root.hidden = true;
          setState("unavailable");
          return;
        }
        root.hidden = false;
        var stored = loadAnswer();
        if (stored && stored.query === query && stored.messages.length > 0) {
          state = stored;
          state.messages.forEach(function (m) { fill(addTurn(m.q), m.a, m.sources); });
          setState("done");
          followUp(i);
          return;
        }
        state = { query: query, history: [], messages: [] };
        saveAnswer(state);
        ask(query, i);
      });
    }

    if (followup && input) {
      followup.addEventListener("submit", function (ev) {
        ev.preventDefault();
        if (busy || !state) return;
        getInfo().then(function (i) {
          if (!i || !i.available) return;
          var max = i.limits && i.limits.maxQuestionChars ? i.limits.maxQuestionChars : 500;
          var q = checkQuestion(input.value, max);
          if (q === null) { say(input.value.trim() === "" ? "" : "toolong"); return; }
          if (conversationFull(state.history, i.limits && i.limits.maxTurns ? i.limits.maxTurns : 8)) { say("limit"); return; }
          input.value = "";
          ask(q, i);
        });
      });
    }

    follow(false);
    window.addEventListener("hashchange", function () { follow(true); });
  }

  function start() {
    var scopes = document.querySelectorAll("[data-caelo-assistant]");
    for (var i = 0; i < scopes.length; i++) bind(scopes[i]);
    var answers = document.querySelectorAll("[data-caelo-assistant-answer]");
    for (var j = 0; j < answers.length; j++) bindAnswer(answers[j]);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
`;

/** The browser script: the widget logic (widget-logic.ts) and the binding. */
export const RUNTIME_JS = `(function () {\n"use strict";\n${LOGIC}\n${MAIN}\n})();\n`;
