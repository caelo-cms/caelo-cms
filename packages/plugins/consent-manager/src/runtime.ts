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
 *   [data-consent-open]             re-open the dialog later; focus
 *                                   moves into it, Escape closes it
 *                                   without recording, and focus
 *                                   returns to the opener
 *   [data-consent-grant="<key>"]    grant one category in place, e.g.
 *                                   on a withheld embed's placeholder;
 *                                   works without a banner on the page
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
import { jsonForInlineScript } from "./tags.js";

/**
 * The first-party cookie holding the visitor's decision, as URI-encoded
 * JSON `{granted: string[], policyVersion: number, at: string}`. The API
 * gateway reads it too (via `visitor_consent_rule`, #677), so the server
 * never sets the visitor-id cookie on a decision the browser did not make.
 */
export const CONSENT_COOKIE = "caelo_consent";

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
 *
 * One hide rule, no show rule (#1139): a show rule has to name a
 * `display` value, and `revert` resets to the browser default (block),
 * which overrode the module's own `display:flex` or `grid`. Lifting the
 * hide leaves the module's layout in charge.
 */
export const RUNTIME_CSS =
  "html:not(.caelo-consent-ask):not(.caelo-consent-open) [data-consent-banner]{display:none}";

/**
 * The runtime body. Plain browser JS, no imports, no template literals
 * (it is embedded in one).
 */
const RUNTIME_BODY = `
var COOKIE = ${JSON.stringify(CONSENT_COOKIE)};
var doc = document;
var root = doc.documentElement;

function warn(msg) {
  if (typeof console !== "undefined" && console.warn) console.warn("[caelo-consent] " + msg);
}

// The editor previews a page in an opaque-origin sandbox (#946), where
// touching document.cookie throws. There the decision lives in memory for
// the document's lifetime: it applies at once (so the operator can preview
// the accepted state) and is gone on the next load.
var cookiesBlocked = false;
var memoryState = null;
function cookieJar() {
  try {
    return doc.cookie;
  } catch (e) {
    cookiesBlocked = true;
    return "";
  }
}

function readCookie() {
  var jar = cookieJar();
  if (cookiesBlocked) return memoryState;
  var parts = jar ? jar.split("; ") : [];
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
  try {
    doc.cookie =
      COOKIE +
      "=" +
      encodeURIComponent(JSON.stringify(state)) +
      ";path=/;max-age=" +
      oneYear +
      ";samesite=lax" +
      (location.protocol === "https:" ? ";secure" : "");
  } catch (e) {
    cookiesBlocked = true;
    memoryState = state;
    warn("this page cannot store cookies (sandboxed preview); the decision lasts until reload");
  }
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

/**
 * Whether this page is already running something the visitor may just
 * have revoked: a loaded tag or a module cloned out of its template.
 */
function somethingLoaded() {
  if (typeof loadedTags !== "undefined") {
    for (var name in loadedTags) {
      if (Object.prototype.hasOwnProperty.call(loadedTags, name)) return true;
    }
  }
  return doc.querySelector('[data-caelo-hydrated="1"]') !== null;
}

function record(keys) {
  var before = granted();
  var revoked = false;
  for (var i = 0; i < before.length; i++) {
    if (keys.indexOf(before[i]) === -1) revoked = true;
  }
  var state = {
    granted: keys,
    policyVersion: CONFIG.policyVersion,
    at: new Date().toISOString(),
  };
  writeCookie(state);
  // The withdrawn categories' cookies go before anything else runs, and
  // on every decision, not only a narrowing one: a decision under a new
  // policy version starts from nothing granted, while the cookies the
  // old consent allowed are still in the jar.
  expireWithdrawnCookies(keys);
  root.classList.remove("caelo-consent-ask");
  root.classList.remove("caelo-consent-open");
  restoreFocus();
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
  // A withdrawal must stop what already runs, and a loaded tag or a
  // cloned-in embed cannot be unloaded in place. Reloading re-renders
  // the page under the narrower decision; the record above is a beacon
  // (or keepalive fetch), so it survives the navigation.
  if (revoked && somethingLoaded()) location.reload();
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
 * inside it can reach the network. The module's CSS rides along as a
 * <style>; its JS is parked as type="text/plain" and run here, once per
 * module, AFTER the markup it queries is in the DOM. A script whose
 * source could end its own script element (a closing script tag or an
 * HTML comment opener; spelled out here they would trip that very check
 * on this runtime) is parked base64-encoded (data-caelo-encoding="base64") and decoded
 * here back to the exact bytes.
 */
var ranModuleScripts = {};
function parkedSource(el) {
  var text = el.textContent || "";
  if (el.getAttribute("data-caelo-encoding") !== "base64") return text;
  var bin = atob(text);
  var bytes = new Uint8Array(bin.length);
  for (var b = 0; b < bin.length; b++) bytes[b] = bin.charCodeAt(b);
  return new TextDecoder().decode(bytes);
}
function runDeferredScripts(block) {
  var parked = block.querySelectorAll("script[data-caelo-deferred-script]");
  for (var i = 0; i < parked.length; i++) {
    var moduleId = parked[i].getAttribute("data-caelo-deferred-script");
    var source = parkedSource(parked[i]);
    parked[i].parentNode.removeChild(parked[i]);
    if (!moduleId || ranModuleScripts[moduleId]) continue;
    ranModuleScripts[moduleId] = true;
    var live = doc.createElement("script");
    live.textContent = source;
    doc.body.appendChild(live);
  }
}

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
    runDeferredScripts(block);
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
    if (openers[o].getAttribute("data-consent-bound") === "1") continue;
    openers[o].setAttribute("data-consent-bound", "1");
    openers[o].addEventListener("click", function (ev) {
      ev.preventDefault();
      openBanner(ev.currentTarget);
    });
  }
  doc.addEventListener("keydown", function (ev) {
    // Only a banner the visitor reopened can be dismissed: one asking for
    // a first decision stays until it gets one.
    if (ev.key !== "Escape" || !root.classList.contains("caelo-consent-open")) return;
    root.classList.remove("caelo-consent-open");
    restoreFocus();
  });
}

/**
 * Reopen the dialog (#1134, #1128). The boxes are re-read from the
 * decision as it stands NOW — it may have changed in this page view or
 * in another tab since the page loaded — and focus moves into the dialog,
 * so a keyboard user is not left on the footer link behind it. No focus
 * trap: the visitor may tab past it (WCAG 2.1.2); Escape closes it.
 */
var lastOpener = null;
function openBanner(opener) {
  var banners = doc.querySelectorAll("[data-consent-banner]");
  if (banners.length === 0) {
    warn("nothing to open: no [data-consent-banner] on this page");
    return;
  }
  for (var b = 0; b < banners.length; b++) prefill(banners[b]);
  var active = doc.activeElement;
  lastOpener = opener || (active && active !== doc.body ? active : null);
  root.classList.add("caelo-consent-open");
  focusInto(visibleBanner(banners));
}

/** The banner the visitor can see; a page may carry one per breakpoint. */
function visibleBanner(banners) {
  for (var i = 0; i < banners.length; i++) {
    if (banners[i].getClientRects && banners[i].getClientRects().length > 0) return banners[i];
  }
  return banners[0];
}

var FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function focusInto(banner) {
  var target = banner.querySelector(FOCUSABLE);
  if (!target) {
    // A dialog with no control of its own still takes focus, so a screen
    // reader announces it instead of staying behind it.
    if (!banner.hasAttribute("tabindex")) banner.setAttribute("tabindex", "-1");
    target = banner;
  }
  if (target.focus) target.focus();
}

/** Back to whatever opened the dialog, if it is still on the page. */
function restoreFocus() {
  var opener = lastOpener;
  lastOpener = null;
  if (opener && opener.focus && doc.documentElement.contains(opener)) opener.focus();
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

/**
 * In-place grants, typically the button on a withheld embed's
 * placeholder. Bound independently of the banner: a site whose banner
 * was never set up must still let a visitor load the one thing they
 * clicked on.
 */
function bindGrants() {
  var grants = doc.querySelectorAll("[data-consent-grant]");
  for (var i = 0; i < grants.length; i++) {
    var node = grants[i];
    if (node.getAttribute("data-consent-bound") === "1") continue;
    node.setAttribute("data-consent-bound", "1");
    node.addEventListener("click", function (ev) {
      ev.preventDefault();
      var key = ev.currentTarget.getAttribute("data-consent-grant");
      if (!key || allKeys().indexOf(key) === -1) {
        warn("[data-consent-grant] names an unknown category: " + key);
        return;
      }
      var next = granted().slice();
      if (next.indexOf(key) === -1) next.push(key);
      record(next);
    });
  }
}

function start() {
  if (currentState() === null) root.classList.add("caelo-consent-ask");
  bind();
  bindGrants();
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
    openBanner(null);
  },
};

if (doc.readyState === "loading") {
  doc.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
`;

/**
 * Emit the runtime with this site's configuration baked in.
 *
 * @param config categories, policy version and endpoint as they stand
 *   at build time.
 * @param tagInjector the tag loader for this site's registered tags. No
 *   tag reaches the document at build time — a tag written into the
 *   page has already run by the time any script could decide whether it
 *   should, so the runtime holds them all and injects only the ones
 *   whose category is granted.
 */
export function buildRuntimeJs(
  config: RuntimeConfig & { slug: string },
  tagInjector: string,
): string {
  return [
    "(function () {",
    '"use strict";',
    `var CONFIG = ${jsonForInlineScript(config)};`,
    tagInjector,
    RUNTIME_BODY,
    "})();",
  ].join("\n");
}
