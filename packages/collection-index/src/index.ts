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
  DEFAULT_PROBE,
  PARTITION_MIN_VECTORS,
  VECTORS_PER_LIST,
} from "./partitions.js";
export {
  type CacheStats,
  FileCache,
  type FileCacheLike,
  type FileFormat,
  type FileLoad,
  type FileSource,
  jsonFormat,
  prefixedCache,
  RAW_FORMAT,
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
  locateDocs,
  lookupDocs,
  type MergePolicy,
  type OpenRelease,
  openRelease,
  PREFETCH_PARALLEL,
  type PrefetchOptions,
  type PrefetchReport,
  parseRelease,
  passageEmbeddingText,
  prefetchRelease,
  RELEASE_FORMAT,
  type ReleaseManifest,
  type ReleaseSegment,
  readProfile,
  readQueryVectors,
  releaseFiles,
  releaseNeedsRebuild,
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
  keywordValues,
  langTerm,
  layoutOf,
  MAX_SLOTS,
  numberValue,
  type Passage,
  type SchemaLayout,
} from "./schema.js";
export {
  DEFAULT_TUNING,
  type FacetCount,
  fuse,
  type Hit,
  keysOfTerms,
  keysPassing,
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
export {
  columnValues,
  compareTerms,
  docPosition,
  type FacetColumn,
  type ParsedDocs,
  SEGMENT_FORMAT,
  type SegmentManifest,
  STORE_BLOCK_BYTES,
} from "./segment.js";
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
export {
  addReleaseVectors,
  decodeVectorShard,
  type EmbedTexts,
  encodeVectorShard,
  type PassageCounts,
  type PassageVector,
  VectorPool,
} from "./vector-pool.js";
export {
  binaryCode,
  defaultRescore,
  type EncodedVector,
  encodeVector,
  normalize,
  RESCORE_SHARE,
} from "./vectors.js";
export { closestWord, editDistance } from "./vocabulary.js";
export {
  buildSegment,
  COMPOUND_PREFIX,
  contentName,
  type FileSink,
  PACK_MAX_BYTES,
  type SegmentTuning,
  SegmentWriter,
  type WriterOptions,
  type WrittenSegment,
} from "./writer.js";
