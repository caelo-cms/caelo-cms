// SPDX-License-Identifier: MPL-2.0

// #1271 — what a build references instead of containing (media, fonts),
// and the stored digests every provider knows those files by.
export {
  ASSET_REFERENCES_FILE,
  type AssetReference,
  type AssetReferences,
  assetSourcePath,
  BUILD_INTERNAL_FILES,
  readAssetReferences,
} from "./asset-references.js";

// #1155 — the marked plugin bake regions a plugin-data build rewrites.
export {
  type BakeRegion,
  bakeRegion,
  findBakeRegions,
  neutralizeBakeMarkers,
  replaceBakeRegions,
} from "./bake-regions.js";
// issue #150 — theme web-font resolver (see fonts-resolver.ts header
// for why it lives here). admin-core re-exports this surface.
// #592 — the build's content-variants pass (resolution + loud refusal).
export { resolveBuildContentVariants } from "./content-variants-pass.js";
export {
  clearSiteFontUsageCache,
  loadSiteFontUsage,
  siteFontUsageScanCount,
} from "./font-usage-sources.js";
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
// Epic #1107 — the list render data assembler the preview loader shares
// with the build (admin-core `lists/load.ts`).
export {
  assembleListRenderData,
  assembleListRenderDataFrom,
  type ListRenderBase,
  ListRenderDataError,
  type ListRenderSources,
  type LoadedListRenderData,
  renderVariants,
  withListOverlays,
} from "./list-data.js";
// #1271 — the build's media pass (references by stored digest).
export { type MediaDelivery, MediaPass } from "./media-pass.js";
// #802 — the file the designated 404 page ships as (the quality audit
// loads it there, not at the page's own path).
export { NOT_FOUND_PAGE_FILE } from "./not-found-page.js";
export {
  type BuildManifest,
  type BuildParity,
  type ContentNormaliser,
  hostNormaliser,
  ParityRecorder,
  PER_BUILD_FILES,
  readBuildParity,
} from "./parity-digest.js";
export {
  axisSpecHash,
  cachedPinnedFaceSlices,
  type PinnedSlice,
  type SliceManifest,
} from "./pinned-font-delivery.js";
export {
  chunkedFileStream,
  digestBytes,
  digestFile,
  digestProfile,
  digestStream,
  hostingGzip,
  type PublishedDigest,
} from "./published-digest.js";
export {
  buildRobotsTxtWithSitemap,
  followUpHeadEntries,
  prepareSeoPass,
  readSeoSettings,
} from "./seo-pass.js";
