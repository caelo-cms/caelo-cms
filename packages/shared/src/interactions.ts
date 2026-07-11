// SPDX-License-Identifier: MPL-2.0

/**
 * issue #160 — the vetted interaction baseline (epic #149).
 *
 * A header without a working mobile menu reads as broken, not minimal
 * — and hand-rolled per-module JS gets focus/aria handling wrong more
 * often than right. This module carries the FUNCTIONAL (non-aesthetic)
 * CSS + JS for the built-in nav renderer: hamburger toggle under the
 * mobile breakpoint, `aria-expanded` bookkeeping, escape-to-close.
 * All colors/spacing stay the module/theme's business — these rules
 * only govern show/hide behaviour, so they don't violate the
 * no-global-look re-scope (#151).
 *
 * The composer includes each asset ONCE per page when at least one
 * nav-menu module rendered (natural dedup, same rule as #158).
 */

/** Functional-only rules: collapse/expand mechanics, zero aesthetics. */
export const NAV_FUNCTIONAL_CSS =
  ".caelo-nav-menu .caelo-nav-toggle{display:none;background:none;border:0;cursor:pointer;padding:0.5rem;color:inherit;font:inherit}" +
  ".caelo-nav-menu .caelo-nav-toggle .caelo-nav-bar{display:block;width:1.25em;height:2px;background:currentColor;margin:0.25em 0}" +
  "@media (max-width: 720px){" +
  ".caelo-nav-menu .caelo-nav-toggle{display:inline-block}" +
  ".caelo-nav-menu > ul{display:none}" +
  '.caelo-nav-menu[data-nav-open="true"] > ul{display:block}' +
  "}";

/**
 * Toggle behaviour. Runs deferred; idempotent per element via the
 * data attribute; closes on Escape and returns focus to the toggle.
 */
export const NAV_TOGGLE_JS =
  "(function(){" +
  "document.querySelectorAll('.caelo-nav-menu').forEach(function(nav){" +
  "var btn=nav.querySelector('.caelo-nav-toggle');if(!btn)return;" +
  "btn.addEventListener('click',function(){" +
  "var open=nav.getAttribute('data-nav-open')==='true';" +
  "nav.setAttribute('data-nav-open',String(!open));" +
  "btn.setAttribute('aria-expanded',String(!open));" +
  "});" +
  "nav.addEventListener('keydown',function(e){" +
  "if(e.key==='Escape'&&nav.getAttribute('data-nav-open')==='true'){" +
  "nav.setAttribute('data-nav-open','false');" +
  "btn.setAttribute('aria-expanded','false');btn.focus();" +
  "}});" +
  "});" +
  "})();";
