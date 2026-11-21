// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin collections (epic #1644, R2/R3): language analysis, immutable
 * content-addressed segments, releases, and the search engine. The indexing
 * job writes with it; the gateway reads with it. It has no dependency on
 * the admin, the database or the network: every file comes through a
 * `FileSource` and goes to a `FileSink`.
 */

export {
  type AnalyzerOptions,
  analyze,
  foldDiacritics,
  hasStemmer,
  primaryLanguage,
  queryVariants,
  STEM_PREFIX,
  stemWord,
  type Token,
} from "./analyze.js";
export { ByteReader, ByteWriter } from "./bytes.js";
export { compoundTailInitials, splitCompound } from "./compound.js";
export {
  type CacheStats,
  FileCache,
  type FileCacheLike,
  type FileSource,
  prefixedCache,
  SegmentReader,
} from "./reader.js";
export {
  type AppliedRelease,
  type ApplyOptions,
  applyChanges,
  type BuildOptions,
  buildRelease,
  type CollectionChanges,
  DEFAULT_MERGE_POLICY,
  lookupDocs,
  type MergePolicy,
  type OpenRelease,
  openRelease,
  parseRelease,
  passageEmbeddingText,
  type ReleaseManifest,
  type ReleaseSegment,
  readProfile,
  releaseFiles,
  schemaDigest,
} from "./release.js";
export {
  type CollectionDoc,
  type CollectionSchema,
  type FieldSpec,
  type FieldValue,
  idTerm,
  type KeyedDoc,
  keywordTerm,
  langTerm,
  layoutOf,
  MAX_SLOTS,
  type Passage,
  type SchemaLayout,
} from "./schema.js";
export {
  DEFAULT_TUNING,
  type FacetCount,
  fuse,
  type Hit,
  type QueryTerms,
  type SearchFilter,
  type SearchTuning,
  searchText,
  searchVectors,
  type TextQuery,
  type TextResult,
  unitePostings,
  type VectorHitDoc,
  type VectorQuery,
} from "./search.js";
export { compareTerms, type SegmentManifest } from "./segment.js";
export { type Highlighted, highlight, type Snippet, snippet } from "./snippet.js";
export {
  type AccessTokenSource,
  type CollectionStore,
  copyMissing,
  directoryStore,
  gcsStore,
  isStoreKey,
  metadataTokenSource,
  scopedStore,
  storeFromUrl,
} from "./store.js";
export { binaryCode, type EncodedVector, encodeVector, normalize } from "./vectors.js";
export { closestWord, editDistance } from "./vocabulary.js";
export {
  buildSegment,
  COMPOUND_PREFIX,
  contentName,
  type FileSink,
  SegmentWriter,
  type WriterOptions,
  type WrittenSegment,
} from "./writer.js";
