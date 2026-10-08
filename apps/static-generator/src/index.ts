// SPDX-License-Identifier: MPL-2.0

// issue #150 — theme web-font resolver (see fonts-resolver.ts header
// for why it lives here). admin-core re-exports this surface.
// #592 — the build's content-variants pass (resolution + loud refusal).
export { resolveBuildContentVariants } from "./content-variants-pass.js";
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
  envNoindexBuildError,
  type GenerateResult,
  generateSite,
  manifestBakesEnvNoindex,
  pageOutputPath,
} from "./generate.js";
export { buildRobotsTxtWithSitemap, readSeoSettings, runSeoPass } from "./seo-pass.js";
