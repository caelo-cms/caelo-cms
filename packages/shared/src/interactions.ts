// SPDX-License-Identifier: MPL-2.0

/**
 * issue #160 — the vetted interaction baseline (epic #149).
 *
 * A header without a working mobile menu reads as broken, not minimal
 * — and hand-rolled per-module JS gets focus/aria handling wrong more
 * often than right. This module carries a small kit of dependency-free
 * interactions (mobile nav, accordion, tabs, carousel) the AI composes
 * from by MARKUP alone: an element carrying `data-caelo-ui="<id>"` pulls
 * that interaction's CSS + JS into the page. No module column, no
 * declaration step — the attribute in the HTML is the declaration, so
 * the AI cannot forget half of it.
 *
 * Every snippet is FUNCTIONAL only: show/hide, scroll-snap, focus and
 * aria bookkeeping. Colors, spacing and typography stay the module /
 * theme's business (`currentColor`, `inherit`), so the kit does not
 * reintroduce a global look (#151 re-scope).
 *
 * Every snippet's JS uses event delegation on `document` instead of
 * binding to elements at load: a module withheld behind a consent gate
 * (`wrapDeferredModule`) enters the DOM only after its plugin clones it
 * out of its `<template>`, long after page load, and must still work.
 *
 * The composer includes each used snippet ONCE per page, in registry
 * order (natural dedup, same rule as #158).
 */

/** One vetted interaction: its functional CSS and its behaviour JS. */
export interface InteractionSnippet {
  readonly css: string;
  readonly js: string;
}

/** Functional-only rules for a collapsible nav (`mobile-nav`): collapse/expand, zero aesthetics. */
const MOBILE_NAV_CSS =
  ".caelo-nav-menu .caelo-nav-toggle{display:none;background:none;border:0;cursor:pointer;padding:0.5rem;color:inherit;font:inherit}" +
  ".caelo-nav-menu .caelo-nav-toggle .caelo-nav-bar{display:block;width:1.25em;height:2px;background:currentColor;margin:0.25em 0}" +
  "@media (max-width: 720px){" +
  ".caelo-nav-menu .caelo-nav-toggle{display:inline-block}" +
  ".caelo-nav-menu > ul{display:none}" +
  '.caelo-nav-menu[data-nav-open="true"] > ul{display:block}' +
  "}";

/** Toggle on click; Escape closes and returns focus to the toggle. */
const MOBILE_NAV_JS =
  "(function(){" +
  "var S='[data-caelo-ui=\"mobile-nav\"]';" +
  "function set(nav,open){nav.setAttribute('data-nav-open',String(open));" +
  "var b=nav.querySelector('.caelo-nav-toggle');if(b)b.setAttribute('aria-expanded',String(open));return b;}" +
  "document.addEventListener('click',function(e){" +
  "var t=e.target;if(!(t instanceof Element))return;" +
  "var b=t.closest('.caelo-nav-toggle');if(!b)return;var nav=b.closest(S);if(!nav)return;" +
  "set(nav,nav.getAttribute('data-nav-open')!=='true');});" +
  "document.addEventListener('keydown',function(e){" +
  "if(e.key!=='Escape')return;var t=e.target;if(!(t instanceof Element))return;" +
  "var nav=t.closest(S+'[data-nav-open=\"true\"]');if(!nav)return;" +
  "var b=set(nav,false);if(b)b.focus();});" +
  "})();";

/**
 * Accordion = native `<details>`/`<summary>` (keyboard + screen-reader
 * support for free). The snippet adds what the platform lacks: a
 * container with `data-single` keeps one panel open, and a URL hash
 * pointing into a panel opens it (deep links to an FAQ answer).
 */
const ACCORDION_CSS = ':where([data-caelo-ui="accordion"] summary){cursor:pointer}';

const ACCORDION_JS =
  "(function(){" +
  "var S='[data-caelo-ui=\"accordion\"]';" +
  "document.addEventListener('toggle',function(e){" +
  "var d=e.target;if(!(d instanceof HTMLDetailsElement)||!d.open)return;" +
  "var acc=d.closest(S);if(!acc||!acc.hasAttribute('data-single'))return;" +
  "acc.querySelectorAll('details[open]').forEach(function(o){if(o!==d&&o.closest(S)===acc)o.open=false;});" +
  "},true);" +
  "function openHash(){var id;try{id=decodeURIComponent(location.hash.slice(1));}catch(_){return;}if(!id)return;" +
  "var el=document.getElementById(id);if(!el)return;var d=el.closest(S+' details');" +
  "if(d&&!d.open){d.open=true;el.scrollIntoView();}}" +
  "window.addEventListener('hashchange',openHash);" +
  "if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',openHash);else openHash();" +
  "})();";

/**
 * Tabs per the WAI-ARIA tabs pattern: `role="tablist"` of
 * `role="tab"` buttons, each `aria-controls` its `role="tabpanel"`.
 * Click or arrow keys / Home / End select (automatic activation) with a
 * roving tabindex. The CSS keeps `hidden` panels hidden even when module
 * CSS gives panels a `display`.
 */
const TABS_CSS = '[data-caelo-ui="tabs"] [role="tabpanel"][hidden]{display:none}';

const TABS_JS =
  "(function(){" +
  "function tabsOf(list){return Array.prototype.filter.call(list.querySelectorAll('[role=\"tab\"]'),function(t){return t.closest('[role=\"tablist\"]')===list;});}" +
  "function select(tab,focus){var list=tab.closest('[role=\"tablist\"]');if(!list)return;" +
  "tabsOf(list).forEach(function(t){var on=t===tab;" +
  "t.setAttribute('aria-selected',String(on));t.setAttribute('tabindex',on?'0':'-1');" +
  "var p=document.getElementById(t.getAttribute('aria-controls')||'');if(p){if(on)p.removeAttribute('hidden');else p.setAttribute('hidden','');}});" +
  "if(focus)tab.focus();}" +
  "function tabAt(e){var t=e.target;if(!(t instanceof Element))return null;" +
  "var tab=t.closest('[role=\"tab\"]');return tab&&tab.closest('[data-caelo-ui=\"tabs\"]')?tab:null;}" +
  "document.addEventListener('click',function(e){var tab=tabAt(e);if(tab)select(tab,false);});" +
  "document.addEventListener('keydown',function(e){var tab=tabAt(e);if(!tab)return;" +
  "var list=tab.closest('[role=\"tablist\"]');if(!list)return;var all=tabsOf(list);var i=all.indexOf(tab);var n=-1;" +
  "if(e.key==='ArrowRight'||e.key==='ArrowDown')n=(i+1)%all.length;" +
  "else if(e.key==='ArrowLeft'||e.key==='ArrowUp')n=(i-1+all.length)%all.length;" +
  "else if(e.key==='Home')n=0;else if(e.key==='End')n=all.length-1;" +
  "if(n<0)return;e.preventDefault();select(all[n],true);});" +
  "})();";

/**
 * Carousel = a CSS scroll-snap track (swipe, trackpad and keyboard
 * scrolling work without JS); the snippet only wires the optional
 * previous / next buttons, honouring `prefers-reduced-motion`. The
 * layout defaults sit in `:where()` (zero specificity): the snippet CSS
 * is emitted after module CSS, and a module must still be able to set
 * its own slide width or track display.
 */
const CAROUSEL_CSS =
  ':where([data-caelo-ui="carousel"] [data-caelo-carousel-track]){display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scroll-behavior:smooth}' +
  ':where([data-caelo-ui="carousel"] [data-caelo-carousel-track]>*){flex:0 0 100%;scroll-snap-align:start}' +
  '@media (prefers-reduced-motion: reduce){[data-caelo-ui="carousel"] [data-caelo-carousel-track]{scroll-behavior:auto}}';

const CAROUSEL_JS =
  "(function(){" +
  "document.addEventListener('click',function(e){var t=e.target;if(!(t instanceof Element))return;" +
  "var b=t.closest('[data-caelo-carousel-prev],[data-caelo-carousel-next]');if(!b)return;" +
  "var c=b.closest('[data-caelo-ui=\"carousel\"]');if(!c)return;" +
  "var track=c.querySelector('[data-caelo-carousel-track]');if(!track)return;" +
  "var dir=b.hasAttribute('data-caelo-carousel-next')?1:-1;" +
  "var reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;" +
  "track.scrollBy({left:dir*track.clientWidth,behavior:reduce?'auto':'smooth'});});" +
  "})();";

/**
 * The vetted kit, in emission order. Keys are the values of
 * `data-caelo-ui`. Adding a snippet: add it here, document its markup
 * contract in `INTERACTION_MARKUP_CONTRACT`, and add a composer test.
 */
export const INTERACTIONS = {
  "mobile-nav": { css: MOBILE_NAV_CSS, js: MOBILE_NAV_JS },
  accordion: { css: ACCORDION_CSS, js: ACCORDION_JS },
  tabs: { css: TABS_CSS, js: TABS_JS },
  carousel: { css: CAROUSEL_CSS, js: CAROUSEL_JS },
} as const satisfies Record<string, InteractionSnippet>;

/** A `data-caelo-ui` value the kit implements. */
export type InteractionId = keyof typeof INTERACTIONS;

const INTERACTION_IDS = Object.keys(INTERACTIONS) as InteractionId[];

function isInteractionId(id: string): id is InteractionId {
  return Object.hasOwn(INTERACTIONS, id);
}

// Matches the attribute only inside a tag: text content carrying the
// same characters is entity-escaped (`&quot;`) by the template engine,
// so it cannot produce a match.
const UI_ATTR_RE = /\sdata-caelo-ui\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Every `data-caelo-ui` value in `html`, split into kit ids and unknown ones. */
export function findInteractionIds(html: string): {
  known: InteractionId[];
  unknown: string[];
} {
  const known = new Set<InteractionId>();
  const unknown = new Set<string>();
  for (const m of html.matchAll(UI_ATTR_RE)) {
    const id = (m[1] ?? m[2] ?? "").trim();
    if (isInteractionId(id)) known.add(id);
    else unknown.add(id);
  }
  return { known: [...known], unknown: [...unknown] };
}

/**
 * The CSS and JS for the used interactions, each once, in registry order
 * (stable output regardless of which module asked first).
 */
export function interactionAssets(used: ReadonlySet<InteractionId>): {
  css: string[];
  js: string[];
} {
  const ids = INTERACTION_IDS.filter((id) => used.has(id));
  return {
    css: ids.map((id) => INTERACTIONS[id].css),
    js: ids.map((id) => INTERACTIONS[id].js),
  };
}

/**
 * The markup contract for each kit interaction, as the AI reads it in
 * tool descriptions and the design-quality skill. One source so the
 * guidance cannot drift from the snippets above.
 */
export const INTERACTION_MARKUP_CONTRACT =
  "`data-caelo-ui` kit — use it instead of JS for these (accessible, shipped once per page, style freely in module CSS):\n" +
  '- `accordion` (FAQ, collapsible): `<div data-caelo-ui="accordion" data-single>` with `<details id="..."><summary>Question</summary><div>Answer</div></details>` items; `data-single` keeps one open; a link to `#<details id>` opens it.\n' +
  '- `tabs`: `<div data-caelo-ui="tabs"><div role="tablist" aria-label="..."><button type="button" role="tab" id="t1" aria-controls="p1" aria-selected="true">...</button><button type="button" role="tab" id="t2" aria-controls="p2" aria-selected="false" tabindex="-1">...</button></div><div role="tabpanel" id="p1" aria-labelledby="t1">...</div><div role="tabpanel" id="p2" aria-labelledby="t2" hidden>...</div></div>`; ids unique on the page.\n' +
  '- `carousel` (slider, testimonials): `<section data-caelo-ui="carousel" aria-roledescription="carousel" aria-label="..."><div data-caelo-carousel-track tabindex="0"><div role="group" aria-roledescription="slide" aria-label="1 of 3">...</div>...</div><button type="button" data-caelo-carousel-prev aria-label="Previous slide"><span aria-hidden="true">&lsaquo;</span></button><button type="button" data-caelo-carousel-next aria-label="Next slide"><span aria-hidden="true">&rsaquo;</span></button></section>`; icon buttons keep visible content aria-hidden, text buttons need no aria-label. One slide per view; set the slides\' `flex-basis` in module CSS to show more.\n' +
  '- `mobile-nav` (menu collapsing behind a toggle on small screens): `<nav class="caelo-nav-menu" data-caelo-ui="mobile-nav" data-nav-open="false"><button type="button" class="caelo-nav-toggle" aria-expanded="false" aria-label="Menu"><span class="caelo-nav-bar"></span><span class="caelo-nav-bar"></span><span class="caelo-nav-bar"></span></button><ul>{{#menu}}<li>…</li>{{/menu}}</ul></nav>` around the module\'s menu `list` field.\n' +
  "Write module JS only for behaviour the kit does not cover.";
