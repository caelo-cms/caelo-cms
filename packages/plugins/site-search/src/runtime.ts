// SPDX-License-Identifier: MPL-2.0

/**
 * The site search's browser side (issue #1651), shipped as a client asset
 * on every page. It binds to search markup the AI writes into the site's
 * own modules, so the search looks like the site:
 *
 *   <form data-caelo-search action="/suche/" role="search">
 *     <input type="search" name="q" data-caelo-search-input aria-label="Suche">
 *     <ul data-caelo-search-suggestions hidden></ul>
 *   </form>
 *
 *   <!-- on the results page -->
 *   <div data-caelo-search-results>
 *     <p data-caelo-search-summary></p>
 *     <ol data-caelo-search-list></ol>
 *     <template data-caelo-search-hit>
 *       <li><a data-field="link"><span data-field="title"></span></a>
 *           <p data-field="snippet"></p></li>   (optional: data-field="section", url)
 *     </template>
 *     <button data-caelo-search-more hidden>Mehr</button>
 *   </div>
 *
 * The field is a combobox (ARIA 1.2): arrow keys move through the
 * suggestions, Enter opens one, Escape closes. An empty field offers the
 * start questions and, when the operator turned them on, the approved
 * popular queries the results page carries. Focus warms the index up
 * (one uncached call naming the current release); every later call names
 * that release, so the CDN can answer it. Requests send no cookie
 * (`credentials: "omit"`). A submitted search and a click on a result are
 * counted only when the operator turned popular suggestions on, after the
 * gateway's proof of work, in the background; nothing is sent while the
 * visitor types.
 */

export const RUNTIME_JS = String.raw`(function () {
  "use strict";
  var API = "/api/plugin/site-search/";
  // The release each operation answers from: a search over link texts is
  // named by two releases, a suggestion by one, so each keeps its own.
  var releases = {};
  var releaseAsked = null;
  var lastQuery = null;

  function lang() {
    var l = (document.documentElement.getAttribute("lang") || "").toLowerCase();
    return /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/.test(l) ? l : "en";
  }

  function get(op, params) {
    var qs = new URLSearchParams(params);
    if (releases[op]) qs.set("release", releases[op]);
    return fetch(API + op + "?" + qs.toString(), { credentials: "omit" }).then(function (res) {
      if (res.status === 409) {
        return res.json().then(function (body) {
          if (!(body && body.release) || body.release === releases[op]) throw new Error(op + " 409");
          releases[op] = body.release;
          return get(op, params);
        });
      }
      if (!res.ok) throw new Error(op + " " + res.status);
      return res.json().then(function (body) {
        if (body && body.release) releases[op] = body.release;
        return body;
      });
    });
  }

  function warm() {
    if (releaseAsked) return releaseAsked;
    releaseAsked = fetch(API + "search/release", { credentials: "omit" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (body) { if (body && body.release) releases.search = body.release; })
      .catch(function () { releaseAsked = null; });
    return releaseAsked;
  }

  function text(el, value) { el.textContent = value == null ? "" : String(value); }

  // Highlights are [start, end) ranges into the text: the markup is built
  // from text nodes and <mark>, never from HTML the index returns.
  function highlighted(el, value, ranges) {
    el.textContent = "";
    var s = String(value || "");
    var at = 0;
    (ranges || []).forEach(function (r) {
      if (r[0] > at) el.appendChild(document.createTextNode(s.slice(at, r[0])));
      var m = document.createElement("mark");
      m.textContent = s.slice(r[0], r[1]);
      el.appendChild(m);
      at = r[1];
    });
    if (at < s.length) el.appendChild(document.createTextNode(s.slice(at)));
  }

  // ---- counting (only when the operator turned popular suggestions on) ----
  function counting() {
    return document.querySelector('[data-caelo-search-popular][data-counting="on"]') !== null;
  }

  function hex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) {
      return b.toString(16).padStart(2, "0");
    }).join("");
  }

  function proof() {
    return fetch("/api/captcha/challenge", { credentials: "omit" }).then(function (res) {
      if (res.status === 204) return null;
      if (!res.ok) throw new Error("captcha challenge " + res.status);
      return res.json().then(function (env) {
        var enc = new TextEncoder();
        var n = 0;
        function next() {
          if (n > 5000000) throw new Error("proof-of-work exceeded its budget");
          var nonce = n.toString(16);
          n += 1;
          return crypto.subtle
            .digest("SHA-256", enc.encode(env.data.challenge + "|site-search.record|" + nonce))
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

  function record(body) {
    if (!counting()) return;
    proof()
      .then(function (p) {
        if (p) body._caelo_captcha = p;
        body.website = "";
        return fetch(API + "record", {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      })
      .catch(function () {});
  }

  // ---- the combobox ----
  var uid = 0;

  function bindForm(form) {
    var input = form.querySelector("[data-caelo-search-input]") || form.querySelector('input[name="q"]');
    var list = form.querySelector("[data-caelo-search-suggestions]");
    if (!input || !list) return;
    uid += 1;
    var listId = list.id || "caelo-search-suggestions-" + uid;
    list.id = listId;
    list.setAttribute("role", "listbox");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", listId);
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("autocomplete", "off");
    var options = [];
    var active = -1;
    var timer = null;
    var seq = 0;

    function close() {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      active = -1;
    }

    function choose(o) {
      if (o.href) location.href = o.href;
      else {
        input.value = o.text;
        form.submit();
      }
    }

    function render(items) {
      list.textContent = "";
      options = items.slice(0, 10);
      active = -1;
      options.forEach(function (o, i) {
        var li = document.createElement("li");
        li.id = listId + "-" + i;
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", "false");
        li.dataset.kind = o.kind;
        text(li, o.text);
        li.addEventListener("mousedown", function (e) { e.preventDefault(); choose(o); });
        list.appendChild(li);
      });
      list.hidden = options.length === 0;
      input.setAttribute("aria-expanded", options.length > 0 ? "true" : "false");
    }

    function move(by) {
      if (options.length === 0) return;
      active = (active + by + options.length) % options.length;
      Array.prototype.forEach.call(list.children, function (li, i) {
        li.setAttribute("aria-selected", i === active ? "true" : "false");
      });
      input.setAttribute("aria-activedescendant", listId + "-" + active);
    }

    function suggest() {
      var q = input.value.trim();
      var mine = ++seq;
      var popular = q === "" ? popularQueries(form) : Promise.resolve([]);
      Promise.all([get("suggest", { q: q, lang: lang() }), popular])
        .then(function (r) {
          if (mine !== seq) return;
          var body = r[0];
          var items = (body.queries || []).map(function (s) { return { kind: s.source || "curated", text: s.text }; });
          r[1].forEach(function (t) { items.push({ kind: "popular", text: t }); });
          (body.docs || []).forEach(function (d) {
            items.push({ kind: "page", text: d.title || d.url, href: d.url });
          });
          render(items);
        })
        .catch(function () { if (mine === seq) close(); });
    }

    input.addEventListener("focus", function () { warm().then(suggest); });
    input.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(suggest, 120);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); if (list.hidden) suggest(); else move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "Escape") { close(); }
      else if (e.key === "Enter" && active >= 0) { e.preventDefault(); choose(options[active]); }
    });
    input.addEventListener("blur", function () { setTimeout(close, 150); });
  }

  // The approved popular queries: baked into the results page (live minutes
  // after an approval, without a Stage) and read once per tab.
  var popularCache = null;
  function popularQueries(form) {
    var own = document.querySelector("[data-caelo-search-popular]");
    if (own) return Promise.resolve(readPopular(own));
    if (popularCache) return popularCache;
    var action = form.getAttribute("action");
    if (!action) return Promise.resolve([]);
    popularCache = fetch(action, { credentials: "omit" })
      .then(function (res) { return res.ok ? res.text() : ""; })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        var el = doc.querySelector("[data-caelo-search-popular]");
        return el ? readPopular(el) : [];
      })
      .catch(function () { return []; });
    return popularCache;
  }

  function readPopular(el) {
    try {
      var data = JSON.parse(el.getAttribute("data-queries") || "{}");
      var mine = data[lang().split("-")[0]] || [];
      return mine.filter(function (t) { return typeof t === "string"; }).slice(0, 5);
    } catch (e) {
      return [];
    }
  }

  // ---- the results page ----
  function bindResults(root) {
    var listEl = root.querySelector("[data-caelo-search-list]");
    var tpl = root.querySelector("template[data-caelo-search-hit]");
    var summary = root.querySelector("[data-caelo-search-summary]");
    var more = root.querySelector("[data-caelo-search-more]");
    if (!listEl || !tpl) return;
    var hasSection = tpl.content.querySelector('[data-field="section"]') !== null;
    var q = (new URLSearchParams(location.search).get("q") || "").trim();
    if (q === "") return;
    var page = 1;
    var inputs = document.querySelectorAll("[data-caelo-search-input]");
    Array.prototype.forEach.call(inputs, function (i) { if (!i.value) i.value = q; });

    function show(body, append) {
      if (!append) listEl.textContent = "";
      (body.hits || []).forEach(function (h) {
        var node = tpl.content.cloneNode(true);
        var href = h.url + (h.snippet && h.snippet.anchor ? "#" + h.snippet.anchor : "");
        Array.prototype.forEach.call(node.querySelectorAll("[data-field]"), function (el) {
          var f = el.getAttribute("data-field");
          if (f === "link") {
            el.setAttribute("href", href);
            el.addEventListener("click", function () {
              record({ kind: "click", text: q, lang: lang(), results: body.total || 0, target: h.url });
            });
          } else if (f === "title") highlighted(el, h.title, h.titleHighlights);
          // The snippet: the section's heading (its own field, or in front
          // of the text) and its best sentence, each with its highlights.
          else if (f === "section") highlighted(el, h.snippet ? h.snippet.heading.text : "", h.snippet ? h.snippet.heading.highlights : []);
          else if (f === "snippet") {
            var sn = h.snippet;
            if (!sn) el.textContent = "";
            else if (hasSection || !sn.heading.text) highlighted(el, sn.text.text, sn.text.highlights);
            else {
              var off = sn.heading.text.length + 3;
              highlighted(el, sn.heading.text + " — " + sn.text.text, sn.heading.highlights.concat(
                sn.text.highlights.map(function (r) { return [r[0] + off, r[1] + off]; })));
            }
          }
          else if (f === "url") text(el, h.url);
        });
        listEl.appendChild(node);
      });
      if (summary) {
        var corr = (body.corrections || []).map(function (c) { return c.to; }).join(" ");
        summary.setAttribute("data-total", String(body.total || 0));
        if (corr) summary.setAttribute("data-correction", corr);
        else summary.removeAttribute("data-correction");
        summary.dispatchEvent(new CustomEvent("caelo-search-results", { bubbles: true, detail: body }));
      }
      if (more) more.hidden = body.more !== true;
    }

    warm().then(function () {
      return get("search", { q: q, lang: lang(), page: "1" });
    }).then(function (body) {
      show(body, false);
      var searched = { kind: "search", text: q, lang: lang(), results: body.total || 0 };
      var previous = lastQueryOf(q);
      if (previous) searched.previous = previous;
      record(searched);
    }).catch(function () {
      root.setAttribute("data-caelo-search-error", "true");
    });

    if (more) more.addEventListener("click", function () {
      page += 1;
      get("search", { q: q, lang: lang(), page: String(page) }).then(function (body) { show(body, true); });
    });
  }

  // A reformulation: the query this tab searched just before, within two
  // minutes. Kept in memory and sessionStorage of this tab only.
  // A query that may be personal data (an address, a long number) is never
  // remembered as the one before: the gateway would drop the next search
  // with it, and the tab need not keep it either.
  function mayBePersonal(q) {
    return q.indexOf("@") !== -1 || /\d{6}/.test(q.replace(/[\s().\/+-]/g, ""));
  }

  function lastQueryOf(q) {
    var prev = null;
    try {
      var raw = sessionStorage.getItem("caelo-search-last");
      var last = raw ? JSON.parse(raw) : null;
      if (last && last.q !== q && Date.now() - last.at < 120000) prev = last.q;
      if (mayBePersonal(q)) sessionStorage.removeItem("caelo-search-last");
      else sessionStorage.setItem("caelo-search-last", JSON.stringify({ q: q, at: Date.now() }));
    } catch (e) {}
    lastQuery = q;
    return prev;
  }

  function start() {
    Array.prototype.forEach.call(document.querySelectorAll("form[data-caelo-search]"), bindForm);
    Array.prototype.forEach.call(document.querySelectorAll("[data-caelo-search-results]"), bindResults);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
`;

/** Minimal styles: the suggestion list floats under the field; the site styles the rest. */
export const RUNTIME_CSS = `[data-caelo-search]{position:relative}
[data-caelo-search-suggestions]{position:absolute;left:0;right:0;z-index:50;margin:0;padding:0;list-style:none;background:Canvas;color:CanvasText;border:1px solid color-mix(in srgb,CanvasText 20%,transparent)}
[data-caelo-search-suggestions] [role=option]{padding:.4em .6em;cursor:pointer}
[data-caelo-search-suggestions] [aria-selected=true]{background:Highlight;color:HighlightText}
[data-caelo-search-results] mark{background:color-mix(in srgb,Highlight 30%,transparent);color:inherit}
`;
