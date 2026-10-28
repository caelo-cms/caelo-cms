// SPDX-License-Identifier: MPL-2.0

import { INTERACTION_MARKUP_CONTRACT } from "@caelo-cms/shared";

/**
 * Run #9 livedit regression (issue #262) — the module-JS runtime
 * contract, stated where the AI authors JS.
 *
 * The composer concatenates every module's `js` into ONE shared
 * `<script defer data-source="modules">` per page (see
 * `packages/shared/src/preview-compose.ts`). There is no per-module
 * wrapper and no implicit binding: a retry-run module shipped
 * `const btn = root.querySelector(…)` assuming a `root` element
 * binding exists — it does not, and every page view threw
 * `ReferenceError: root is not defined`. Nothing in any tool schema
 * said so; this constant closes that gap as the single source of
 * truth for every module-authoring tool's `js` input.
 *
 * issue #160 — it also carries the vetted interaction kit's markup
 * contract: the moment the AI is about to write JS is the moment it
 * should learn that an accordion / tabs / carousel needs none.
 */
/**
 * e2e-livedit detected bugs — the AI wrapped whole `html` / `css` values
 * in `<![CDATA[ … ]]>` (a habit of XML-shaped tool-call encodings: a
 * long markup string looks like XML text that needs escaping). No prompt
 * surface showed CDATA; the parameters simply never said they are plain
 * strings, so the authoring tools state the shape up front. The note alone
 * did not stop it, so a whole-value envelope is also decoded at the tool
 * boundary (`sourceTextArg` in shared `ai-tools.ts`); any other CDATA marker
 * in CSS / JS is still refused by the op (shared `content.ts`).
 */
export const MODULE_SOURCE_VALUE_NOTE = "Plain source (no CDATA or extra escaping).";

/** `html` parameter description for every module-authoring tool. */
export const MODULE_HTML_DESCRIPTION =
  `Module HTML. ${MODULE_SOURCE_VALUE_NOTE} ` +
  "Placeholders: `{{field}}` primitives, `{{>field}}` single nested `module`, `{{#field}}…{{/field}}` `list` and `module-list`. " +
  "Accordion, tabs, carousel, mobile-nav -> `data-caelo-ui` markup (see `js`) instead of custom JS.";

/** `css` parameter description for every module-authoring tool. */
export const MODULE_CSS_DESCRIPTION =
  `Module CSS. ${MODULE_SOURCE_VALUE_NOTE} ` +
  "MUST scope every selector under the module's root class — bare selectors (`body`, `h1`, `.card`) bleed into other modules and are flagged.";

/** `js` parameter description for every module-authoring tool: runtime contract + interaction kit. */
export const MODULE_JS_CONTRACT =
  `Vanilla JS. ${MODULE_SOURCE_VALUE_NOTE} ` +
  "Emitted ONCE per page into a shared `<script defer>` with all other modules — SHARED top-level scope, NO implicit `root`/`el`/`module`/`this`. " +
  "Wrap in an IIFE, query `document.querySelectorAll('.your-module-root …')`, iterate matches so multiple placements work. Omit for presentational modules. " +
  "Touch ONLY this module's markup — another module's script goes into that module, never into a header/footer because it loads everywhere. Text, links, menu entries live in `html` (crawlers read no js output); js only shows/hides/toggles. Deliberate site-wide behaviour on hooks many modules share: comment `/* caelo:site-wide: <reason> */`. " +
  INTERACTION_MARKUP_CONTRACT;

/** `bindThemeLiterals` parameter description for every module-authoring tool. */
export const MODULE_BIND_THEME_LITERALS_DESCRIPTION =
  "Rewrite CSS literals matching a theme token into `var(--…)`. Default true — omit unless keeping a deliberate off-palette literal.";
