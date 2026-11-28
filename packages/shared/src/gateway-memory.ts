// SPDX-License-Identifier: MPL-2.0

/**
 * What a public gateway holds in memory (epic #1644), so the memory each
 * provider gives it (`GATEWAY_MEMORY_DEFAULT`, provisioning
 * stack-contract.ts) is checked against it instead of guessed.
 *
 * History. #1745 (2026-11-26, searchVIU): the live gateway ran with 1 GiB;
 * loading the default embedding model took it from 10 % to at least 87 %
 * (789 MiB for the model's load on top of about 102 MiB), and one instance
 * was lost in the middle of a first semantic search. The answer then was
 * 2 GiB. #1777 (2026-11-27) removed the causes instead: the model without
 * its token table in the graph and a compact tokenizer (#1782), and a cache
 * bound that counts what parsed files hold (#1780).
 *
 * Measured on an M3 (fresh process, 2026-11-27): the model's load grows the
 * process by 171 to 217 MB at its peak (before: about 570 MB); a cache
 * filled to its budget holds about 1.25 times that budget on the heap, up
 * to 1.5 times with the garbage between collections. Cloud Run's gateway
 * needed 1.38 times the M3's figure for the model (789 against 570 MiB), so
 * its peak is taken as that factor times the M3's: about 300 MiB.
 */

/**
 * Megabytes of collection index files a gateway keeps parsed, unless
 * `CAELO_COLLECTIONS_CACHE_MB` says otherwise. Counted as the files hold
 * them parsed (#1780); a 7.6 MB index like searchVIU's never fills it.
 */
export const COLLECTIONS_CACHE_MB_DEFAULT = 128;

/** Heap a filled cache takes per megabyte of its budget, with the garbage between collections. */
export const COLLECTIONS_CACHE_HEAP_FACTOR = 1.5;

/**
 * The gateway process with its plugins and the default embedding model, at
 * the peak of the model's load, on Cloud Run (1 vCPU): about 102 MiB for the
 * process (measured), about 300 MiB for the model's load (the M3's 217 MB
 * times 1.38). The index cache comes on top.
 */
export const GATEWAY_PEAK_WITH_MODEL_MIB = 410;
