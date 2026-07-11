// SPDX-License-Identifier: MPL-2.0

// issue #150 — theme web-font resolver (see fonts-resolver.ts header
// for why it lives here). admin-core re-exports this surface.
export {
  clearFontResolverMemo,
  defaultFontsCacheDir,
  type ResolvedThemeFonts,
  type ResolveThemeFontsArgs,
  resolveThemeFonts,
} from "./fonts-resolver.js";
export {
  buildRobotsTxt,
  type DeployTarget,
  type GenerateResult,
  generateSite,
  pageOutputPath,
} from "./generate.js";
