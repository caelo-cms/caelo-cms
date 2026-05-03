// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/site-importer — P14.
 *
 * Crawl an existing public site at a URL, extract per-page modules
 * (heuristic: header / N x sections / footer), pull theme tokens
 * from sampled CSS, and stage the result as draft pages the Owner
 * reviews + accepts in /security/import.
 *
 * Pure ESM, depends only on htmlparser2 (already in the tree). Does
 * not require Playwright — uses Bun's native `fetch` + same-origin
 * BFS within `depth` + `maxPages` bounds. Screenshot capture is a
 * separate optional step (P14 review pass wires it via Playwright
 * once the dep tree is willing to carry the binary).
 */

export { type CrawlOptions, type CrawlResult, crawlSite } from "./crawler.js";
export {
  type ExtractedModule,
  type ExtractedPage,
  extractModulesFromHtml,
  extractThemeTokens,
  extractTitle,
} from "./extractor.js";
export {
  computePixelDiff,
  createPlaywrightScreenshotter,
  type Screenshot,
  type Screenshotter,
} from "./screenshot.js";
export {
  computeDiffStatus,
  type DiffResult,
  type DiffStatus,
} from "./screenshot-diff.js";
