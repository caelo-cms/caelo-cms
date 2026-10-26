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
export const MODULE_SOURCE_VALUE_NOTE =
  "Plain source text exactly as it is served: no `<![CDATA[ … ]]>` wrapper and no escaping of the whole value (`&lt;div&gt;` is wrong, `<div>` is right) (the tool input is JSON — the string needs nothing beyond JSON escaping).";

/**
 * `html` / `css` parameter description for the template and layout tools.
 * They took plain strings without saying so, and the AI sent a template
 * body HTML-escaped as a whole (e2e-livedit run 40344374447) — the same
 * class the module tools already state up front.
 */
export const SHELL_HTML_DESCRIPTION = `Template / layout HTML: render slots are <caelo-slot name="X"></caelo-slot> tags. ${MODULE_SOURCE_VALUE_NOTE}`;
export const SHELL_CSS_DESCRIPTION = `Template / layout CSS. ${MODULE_SOURCE_VALUE_NOTE}`;

/** `html` parameter description for every module-authoring tool. */
export const MODULE_HTML_DESCRIPTION = `Module HTML. ${MODULE_SOURCE_VALUE_NOTE}`;

/** `css` parameter description for every module-authoring tool. */
export const MODULE_CSS_DESCRIPTION = `Module CSS. ${MODULE_SOURCE_VALUE_NOTE}`;

export const MODULE_JS_CONTRACT =
  "Vanilla JS. Emitted ONCE per page into a single shared <script defer> concatenated with every other module's JS — top-level scope is SHARED and there is NO implicit binding: `root`, `el`, `module`, and `this` are NOT defined. " +
  "Wrap everything in an IIFE, select elements with document.querySelectorAll('.your-module-root-class …'), and iterate the matches so multiple placements of the module on one page all work. " +
  "Omit entirely for purely presentational modules. " +
  `${MODULE_SOURCE_VALUE_NOTE} ` +
  INTERACTION_MARKUP_CONTRACT;
