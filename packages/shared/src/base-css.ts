// SPDX-License-Identifier: MPL-2.0

/**
 * issue #151 (re-scoped, epic #149) — the INVISIBLE technical baseline.
 *
 * Deliberately carries ZERO visible design opinion: no type scale, no
 * colors, no element styling — every visible default is compiled per
 * site from that site's chosen design (#164), because a global look
 * would homogenize Caelo sites (the operator explicitly rejected that).
 *
 * What remains is the technical floor every hand-built page and every
 * Genesis draft silently assumes, and whose absence produces the
 * "subtly broken" rendering class from the epic review:
 *
 *   - border-box sizing (the universal expectation since ~2013);
 *   - no default body margin (the 8px UA gutter breaks full-bleed
 *     heroes on every design);
 *   - media elements can't overflow their container (mobile-first
 *     drafts assume it);
 *   - form controls inherit the page's font instead of UA chrome.
 *
 * Injected as `<style data-source="base">` between the theme vars and
 * the aggregated module CSS, so any module rule overrides it trivially.
 */

export const BASE_TECHNICAL_CSS =
  "*,*::before,*::after{box-sizing:border-box}" +
  "body{margin:0}" +
  "img,picture,video,canvas,svg{display:block;max-width:100%}" +
  "input,button,textarea,select{font:inherit}";
