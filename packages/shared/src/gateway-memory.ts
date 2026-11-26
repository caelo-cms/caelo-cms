// SPDX-License-Identifier: MPL-2.0

/**
 * What a public gateway holds in memory (epic #1644), so the memory each
 * provider gives it (`GATEWAY_MEMORY_DEFAULT`, provisioning
 * stack-contract.ts) is checked against it instead of guessed.
 *
 * #1745 (2026-11-26, searchVIU): the live gateway ran with 1 GiB. Loading the
 * default embedding model for the first semantic search took its memory
 * from 10 % to at least 87 % (70 % once loaded), and one instance was lost
 * in the middle of that search, which the visitor saw as "Suche nicht
 * erreichbar". The figures below are those measurements, not the M3
 * benchmark (about 570 MB for the model alone), which left out the
 * process around it.
 */

/** Megabytes of collection index files a gateway keeps parsed, unless `CAELO_COLLECTIONS_CACHE_MB` says otherwise. */
export const COLLECTIONS_CACHE_MB_DEFAULT = 256;

/**
 * The gateway process with its plugins and the default embedding model, at
 * the peak of the model's load, measured on Cloud Run (1 vCPU): about
 * 110 MiB for the process, up to about 790 MiB more while the model loads.
 * The index cache comes on top ({@link COLLECTIONS_CACHE_MB_DEFAULT}).
 */
export const GATEWAY_PEAK_WITH_MODEL_MIB = 900;
