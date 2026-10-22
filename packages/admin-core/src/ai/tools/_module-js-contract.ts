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
export const MODULE_JS_CONTRACT =
  "Vanilla JS. Emitted ONCE per page into a single shared <script defer> concatenated with every other module's JS — top-level scope is SHARED and there is NO implicit binding: `root`, `el`, `module`, and `this` are NOT defined. " +
  "Wrap everything in an IIFE, select elements with document.querySelectorAll('.your-module-root-class …'), and iterate the matches so multiple placements of the module on one page all work. " +
  "Omit entirely for purely presentational modules. " +
  INTERACTION_MARKUP_CONTRACT;
