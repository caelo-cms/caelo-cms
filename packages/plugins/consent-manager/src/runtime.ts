// SPDX-License-Identifier: MPL-2.0

/**
 * The consent runtime — the part of this plugin that must work no
 * matter how the site's markup was authored.
 *
 * ## Why the plugin owns this and the AI owns everything else
 *
 * Recording a choice, keeping a tag from firing before it, and holding
 * an embed until the visitor agrees are the parts a regulator asks
 * about. They cannot depend on AI-authored module JS being right this
 * time. So the plugin ships behaviour and the AI ships every visible
 * thing — markup, copy, layout, colour — bound together by documented
 * attributes rather than by fixed HTML.
 *
 * The contract, in full:
 *
 *   [data-consent-banner]           the dialog root; shown only when a
 *                                   choice is missing or out of date
 *   [data-consent-category="<key>"] a checkbox for one category
 *   [data-consent-accept-all]       grant everything
 *   [data-consent-reject-all]       grant only what is required
 *   [data-consent-save]             grant exactly what is ticked
 *   [data-consent-open]             re-open the dialog later
 *
 * ## Why it is baked at build time
 *
 * The runtime has to decide whether a tag may fire before anything
 * loads. A static site cannot afford a blocking fetch to learn that,
 * so the categories and (from #452) the tags are baked into this file
 * by `buildAssets` (#449).
 *
 * ## No silent no-ops
 *
 * A missing or misspelled hook is reported to the console naming the
 * attribute that was expected. A banner that quietly does nothing is
 * the worst outcome available here: the site looks compliant and
 * records nothing.
 */

import type { ConsentCategory } from "./categories.js";

/** What gets baked into the emitted runtime. */
export interface RuntimeConfig {
  readonly categories: ReadonlyArray<Pick<ConsentCategory, "key" | "displayName" | "required">>;
  /** Bumping it re-asks every visitor. */
  readonly policyVersion: number;
  /** Where the runtime posts the record. */
  readonly recordEndpoint: string;
}

/**
 * Hides the dialog before first paint and reveals it only when the
 * runtime decides a choice is needed.
 *
 * Doing it the other way round — visible in markup, hidden by script —
 * flashes the banner on every page for visitors who already answered,
 * which reads as a broken site and trains people to dismiss it without
 * looking.
 */
export const RUNTIME_CSS = `[data-consent-banner]{display:none}
html.caelo-consent-ask [data-consent-banner]{display:revert}
html.caelo-consent-open [data-consent-banner]{display:revert}`;

/**
 * The runtime body. Plain browser JS, no imports, no template literals
 * (it is embedded in one).
 */
const RUNTIME_BODY = String.raw`
var COOKIE = "caelo_consent";
var doc = document;
var root = doc.documentElement;

function warn(msg) {
  if (typeof console !== "undefined" && console.warn) console.warn("[caelo-consent] " + msg);
}

function readCookie() {
  var parts = doc.cookie ? doc.cookie.split("; ") : [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (p.indexOf(COOKIE + "=") !== 0) continue;
    try {
      var parsed = JSON.parse(decodeURIComponent(p.slice(COOKIE.length + 1)));
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.granted)) return parsed;
    } catch (e) {
      // A cookie we cannot read is a cookie we have no consent from.
      return null;
    }
    return null;
  }
  return null;
}

function writeCookie(state) {
  var oneYear = 365 * 24 * 60 * 60;
  doc.cookie =
    COOKIE +
    "=" +
    encodeURIComponent(JSON.stringify(state)) +
    ";path=/;max-age=" +
    oneYear +
    ";samesite=lax" +
    (location.protocol === "https:" ? ";secure" : "");
}

function requiredKeys() {
  var out = [];
  for (var i = 0; i < CONFIG.categories.length; i++) {
    if (CONFIG.categories[i].required) out.push(CONFIG.categories[i].key);
  }
  return out;
}

function allKeys() {
  var out = [];
  for (var i = 0; i < CONFIG.categories.length; i++) out.push(CONFIG.categories[i].key);
  return out;
}

/** Current choice, or null when none applies to this policy version. */
function currentState() {
  var s = readCookie();
  if (!s) return null;
  if (s.policyVersion !== CONFIG.policyVersion) return null;
  return s;
}

function granted() {
  var s = currentState();
  return s ? s.granted : requiredKeys();
}

function isGranted(key) {
  var g = granted();
  for (var i = 0; i < g.length; i++) if (g[i] === key) return true;
  return false;
}

function record(keys) {
  var state = {
    granted: keys,
    policyVersion: CONFIG.policyVersion,
    at: new Date().toISOString(),
  };
  writeCookie(state);
  root.classList.remove("caelo-consent-ask");
  root.classList.remove("caelo-consent-open");
  apply();
  // Proof-of-consent lives server-side; the cookie is only what the
  // browser needs to act. A failed post must not undo the visitor's
  // choice, so it is reported and not retried into a loop.
  try {
    var body = JSON.stringify({ granted: keys, policyVersion: CONFIG.policyVersion });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(CONFIG.recordEndpoint, new Blob([body], { type: "application/json" }));
    } else {
      fetch(CONFIG.recordEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body,
        credentials: "include",
        keepalive: true,
      })["catch"](function () {
        warn("could not record the consent decision server-side");
      });
    }
  } catch (e) {
    warn("could not record the consent decision server-side");
  }
}

function tickedKeys(banner) {
  var out = requiredKeys();
  var boxes = banner.querySelectorAll("[data-consent-category]");
  for (var i = 0; i < boxes.length; i++) {
    var key = boxes[i].getAttribute("data-consent-category");
    if (!key || out.indexOf(key) !== -1) continue;
    if (boxes[i].checked) out.push(key);
  }
  return out;
}

/** Re-run every consumer of the current decision. */
function apply() {
  hydrateDeferred();
  loadTags();
}

/**
 * Reveal modules core withheld at build time (#450). The real markup
 * sits in an inert <template>; cloning it is the first moment anything
 * inside it can reach the network.
 */
function hydrateDeferred() {
  var blocks = doc.querySelectorAll('[data-caelo-deferred="' + CONFIG.slug + '"]');
  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i];
    if (block.getAttribute("data-caelo-hydrated") === "1") continue;
    var reason = block.getAttribute("data-reason");
    if (!reason || !isGranted(reason)) continue;
    var tpl = block.querySelector("template[data-caelo-deferred-content]");
    if (!tpl) {
      warn("a withheld module has no <template> to restore — module=" + block.getAttribute("data-module"));
      continue;
    }
    var ph = block.querySelector("[data-caelo-deferred-placeholder]");
    if (ph && ph.parentNode) ph.parentNode.removeChild(ph);
    block.appendChild(tpl.content.cloneNode(true));
    block.setAttribute("data-caelo-hydrated", "1");
  }
}

function bind() {
  var banners = doc.querySelectorAll("[data-consent-banner]");
  if (banners.length === 0) {
    if (currentState() === null) {
      warn(
        "no [data-consent-banner] on this page, so the visitor is never asked. Add the consent banner module to the site LAYOUT.",
      );
    }
    return;
  }
  for (var b = 0; b < banners.length; b++) {
    var banner = banners[b];
    if (banner.getAttribute("data-consent-bound") === "1") continue;
    banner.setAttribute("data-consent-bound", "1");

    var acceptAll = banner.querySelectorAll("[data-consent-accept-all]");
    var rejectAll = banner.querySelectorAll("[data-consent-reject-all]");
    var save = banner.querySelectorAll("[data-consent-save]");
    if (acceptAll.length === 0 && save.length === 0) {
      warn(
        "the banner has neither [data-consent-accept-all] nor [data-consent-save], so nothing can grant consent",
      );
    }
    if (rejectAll.length === 0) {
      warn(
        "the banner has no [data-consent-reject-all]; declining must be as easy as accepting",
      );
    }
    bindAll(acceptAll, allKeys);
    bindAll(rejectAll, requiredKeys);
    bindSave(save, banner);
    prefill(banner);
  }
  var openers = doc.querySelectorAll("[data-consent-open]");
  for (var o = 0; o < openers.length; o++) {
    openers[o].addEventListener("click", function (ev) {
      ev.preventDefault();
      root.classList.add("caelo-consent-open");
    });
  }
}

function bindAll(nodes, keysFn) {
  for (var i = 0; i < nodes.length; i++) {
    nodes[i].addEventListener("click", function (ev) {
      ev.preventDefault();
      record(keysFn());
    });
  }
}

function bindSave(nodes, banner) {
  for (var i = 0; i < nodes.length; i++) {
    nodes[i].addEventListener("click", function (ev) {
      ev.preventDefault();
      record(tickedKeys(banner));
    });
  }
}

/** Show the visitor what they chose last time, not a blank form. */
function prefill(banner) {
  var boxes = banner.querySelectorAll("[data-consent-category]");
  for (var i = 0; i < boxes.length; i++) {
    var key = boxes[i].getAttribute("data-consent-category");
    if (!key) continue;
    var known = false;
    for (var c = 0; c < CONFIG.categories.length; c++) {
      if (CONFIG.categories[c].key === key) known = true;
    }
    if (!known) {
      warn('unknown category "' + key + '" in the banner — it will never be granted');
      continue;
    }
    boxes[i].checked = isGranted(key);
    for (var r = 0; r < CONFIG.categories.length; r++) {
      if (CONFIG.categories[r].key === key && CONFIG.categories[r].required) {
        boxes[i].checked = true;
        boxes[i].disabled = true;
      }
    }
  }
}

function start() {
  if (currentState() === null) root.classList.add("caelo-consent-ask");
  bind();
  apply();
}

window.caeloConsent = {
  granted: granted,
  isGranted: isGranted,
  grantAll: function () {
    record(allKeys());
  },
  rejectAll: function () {
    record(requiredKeys());
  },
  open: function () {
    root.classList.add("caelo-consent-open");
  },
};

if (doc.readyState === "loading") {
  doc.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
`;

/** No tag support yet — #452 replaces this with the real injector. */
const TAGS_STUB = "function loadTags() {}\n";

/**
 * Emit the runtime with this site's configuration baked in.
 *
 * @param config categories, policy version and endpoint as they stand
 *   at build time.
 */
export function buildRuntimeJs(config: RuntimeConfig & { slug: string }): string {
  return [
    "(function () {",
    '"use strict";',
    `var CONFIG = ${JSON.stringify(config)};`,
    TAGS_STUB,
    RUNTIME_BODY,
    "})();",
  ].join("\n");
}
