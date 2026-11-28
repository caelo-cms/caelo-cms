# Embedding models: the core catalog and semantic search

Epic #1644, rule change R7, issue #1650. This page covers how semantic search
gets its vectors: what the model catalog is, where model files come from, which
runtime runs them, and what keeps the index side and the query side in step.

## The catalog

`packages/shared/src/embedding-models.ts` holds the approved models. It is data
only (subpath `@caelo-cms/shared/embedding-models`), so the plugin SDK can
validate config values against it without pulling in anything else.

Each entry pins:

- the publisher's Hugging Face repository at one commit;
- every file by SHA-256 and size (the ONNX graph and `tokenizer.json`), and
  the files Caelo derives from them (`derived`, below);
- dimensions, `maxTokens` (a longer text is cut, keeping its start), pooling,
  query and passage prefixes, the padding id, and the graph's input and
  output names;
- the licence (MIT or Apache-2.0 only, CLAUDE.md §3) and its copyright line.

No plugin ships a model or a binary. A plugin names a catalog model in its
configuration:

- a `catalogModel` config leaf, whose value schema is the catalog's ids or
  `null` (search by words only);
- the collection's `vectorModelConfig` points at that leaf.

The admin form offers the catalog as a select, and the AI tools list the ids.

**Today the catalog has one model: `granite-embedding-97m-multilingual-r2`.**
`packages/collection-index/bench/semantic-results.md` has the measurements that
chose it. Every entry ships in both images (about 105 MB of derived files
each), so a model joins only when a measurement shows that sites need what
the default cannot do.

A release records `<id>@<first 12 hex of the graph's SHA-256>` (the
fingerprint) as its vector model, so a new revision of the same id counts as a
different model.

## Files: fetched once, verified twice

There is no download at run time. The files come in two steps.

**At image build**, `packages/models/scripts/fetch-models.ts` runs in the
`models` stage of `apps/admin/Dockerfile` and `apps/api-gateway/Dockerfile`:

- it downloads from the pinned revision;
- it keeps a file under its name only when the size and SHA-256 match (it is
  written beside it and renamed once verified);
- it writes each model's `NOTICE.txt` (source, revision, licence text from
  `licenses/`);
- it stamps one fixed time on everything, so the same models give the same
  layer digest (#1559).

The stage copies only the catalog and the fetch code, so it re-runs only when
the catalog changes. The files land in `/opt/caelo/models/<id>/<revision>/`,
and `CAELO_MODELS_DIR` points there.

### Derived files: what a process loads (#1782)

After the download the stage derives three files from the publisher's (all
dependency-free code, `packages/models/src/derive.ts`), checks them against
the catalog's pins like the downloads, and `--runtime-only` drops the
publisher's files: the images carry only these.

- **`graph.onnx`**: the publisher's graph without its token table. The
  table (Granite 97M: 180,000 × 384 uint8, 69 of the graph's 97 MB) is read
  by one `Gather` at the graph's start; the transform removes that node and
  its initializer and makes the gathered rows a graph input
  (`token-table.ts`). The rest is copied byte for byte.
- **`tokens.bin`**: that table, row by row. The embedder looks up a text's
  rows itself (a query: about twenty) and hands them to the graph, which
  dequantises them in its next node exactly as before.
- **`tokenizer.bin`**: the tokenizer's vocabulary, merges, added tokens and
  template as typed arrays (`bpe.ts`), about 20 MB in memory where
  `@huggingface/tokenizers` held 138 MB of maps. It cuts text exactly like
  that library with the publisher's `tokenizer.json` (the library's
  translation of the split regex is pinned in the catalog); `bpe.test.ts`
  compares both on this repository's documentation and generated edge cases
  (on 2026-11-27: 42,046 texts, 3.05 million tokens, no difference).

The split graph fed the gathered rows computes bit for bit what the
publisher's graph computes, on native and on WebAssembly
(`token-table.test.ts`), so the model keeps its fingerprint and no index is
rebuilt. The licence notice says what was changed (Apache-2.0 §4(b)).

**When a process loads a model**, it re-hashes the bytes before handing them
to ONNX Runtime (`packages/models/src/files.ts`):

- a missing or different file is a `ModelFileError` that names
  `bun run models:fetch`;
- the graph is created from bytes, so it cannot name an external data file;
- no custom operator library is registered: the model is data for the
  runtime's standard operators.

## Runtimes

| Where | Runtime | Why |
|---|---|---|
| `collection_index` job (and a self-hosted admin's in-process job) | `onnxruntime-node` (native CPU), `@caelo-cms/models/native` | Embeds a whole site's passages, about five times faster than WebAssembly. Runs no visitor input. |
| Gateway (live and staging) | `onnxruntime-web` WebAssembly, `@caelo-cms/models/wasm` | Embeds one visitor query. No native code touches a visitor's text next to the gateway's credentials (the reasoning of the capture job, #1217). |
| Admin (search preview, the Stage audit's test queries) | `onnxruntime-web` WebAssembly, `@caelo-cms/models/wasm` | Embeds one query the way the gateway does, so the preview ranks like the live search. |

Both runtimes are 1.31.1 (MIT). The tokenizer is the compact one above (pure
JavaScript); `@huggingface/tokenizers` 0.2.0 (Apache-2.0) is only a
development dependency now, the reference `bpe.test.ts` compares with.
`packages/models/src/model.test.ts` compares the token ids with ids recorded
from the Rust reference (`src/__fixtures__/`).

How each image carries the runtimes:

- **Gateway.** The image bundles ONNX Runtime's JavaScript.
  `apps/api-gateway/image.ts` stages only `ort-wasm-simd-threaded.{wasm,mjs}`,
  loaded from `CAELO_ORT_WASM_DIR`. The SBOM lists each derived graph as
  `pkg:huggingface/<repo>@<revision>`, the model it was derived from.
- **Admin.** The Dockerfile drops every native library but linux x64 and
  every WebAssembly build but the SIMD one. That removes about 400 MB of the
  435 MB the two packages install. The SvelteKit server does NOT bundle
  ONNX Runtime (`ssr.external` in `apps/admin/vite.config.ts`): both builds
  find their runtime files next to their own module, so inlined into a
  server chunk they look in `build/server/chunks/` and fail (0.12.11: every
  semantic query in the admin failed on `ort-wasm-simd-threaded.mjs`).

Memory and speed of the default model (M3 Pro, one thread, fresh process,
2026-11-27; the growth of the process's resident memory once the model has
answered, and at the peak of its load):

| | Load | Memory (steady / peak) |
|---|---|---|
| Gateway (WebAssembly), before #1782 | 0.8 to 1.2 s | 463 / 494 MB, tokenizer (138 MB) included |
| Gateway (WebAssembly), derived files | 0.58 s | 169 to 178 / 171 to 217 MB, tokenizer included |
| Index job (native), derived files | 0.6 to 0.75 s | 69 to 86 / 108 to 125 MB |

About 120 MB of the WebAssembly figure is ONNX Runtime's own (a session for
a one-node graph costs that); the session of the derived graph adds about
80 MB. Loading holds the event loop 65 to 88 ms. A worker thread was tried
(#1778): it cut that to 12 to 20 ms but added 0.5 to 1.1 s to every load (its
own runtime, its own WebAssembly compile), and the load is what a cold
first search waits for, so the model stays in the gateway's thread.

**On Cloud Run the index job is slower than the M3 numbers.** Measured on
2026-11-26 with searchviu.com's passages (648 characters on average, about
1.8 times the bench's cost), a 2-vCPU job task embedded 10 to 19 passages a
second on two threads, depending on the host (Intel Xeon 2.0/2.8 GHz, AMD
EPYC). Two threads need `cpuBudget()` (`packages/models/src/cpu-budget.ts`):
Cloud Run's quota is just under two CPUs (1.61 or 1.97), and
`os.availableParallelism()` rounds that down to one, which embedded at 6 to 8
a second. Large builds therefore run as several tasks
(`docs/plugin-collections.md`, wide attempts), and a passage whose text did
not change is never embedded again.

**On Cloud Run the gateway needed more than the M3 numbers.** Measured on
2026-11-26 on searchviu.com's live gateway (1 vCPU, then 1 GiB) with the
publisher's files: loading the default model took the instance from 10 % of
its memory to at least 87 %, and it stayed at 70 % (about 102 to 110 MiB is
the gateway process with its plugins), 1.38 times the M3's figure. One
instance was lost in the middle of that load, inside a visitor's first
search, which showed "Suche nicht erreichbar"; a first search on a cold
instance took 11 s. #1747 raised the gateway to 2 GiB; #1777 removed the
causes:

- **The gateway runs with 1 GiB again** (`GATEWAY_MEMORY_DEFAULT`): the
  derived files' peak (217 MB on the M3, so about 300 MiB on Cloud Run) and
  the process (about 110 MiB) leave room for a full index cache counted as
  it is held (128 MiB by default, up to 1.5 times that on the heap) with a
  quarter of the memory to spare (`packages/shared/src/gateway-memory.ts`,
  `admin-memory.test.ts`). To be measured on Cloud Run once a release ships
  it (#1777).
- **The model loads ahead of the search, inside a request, beside the
  index files.** The site search asks for the release key when the visitor
  focuses the field; when the gateway answers it, `/release` answers once
  the release is open, its index files are in memory and the model is
  loaded, the two at the same time (bounded to 20 s), so a cold instance
  warms while the visitor types. It never loads after an answer: on
  request-billed CPU that work would wait for the next request, which is
  the search. The admin's refresh ping after a publish opens the new
  releases but leaves the model to `/release` (the admin waits for the
  ping). Each load writes `[collections] model <id> loaded in <ms> ms
  (process memory <MiB> MiB)`.
- **Known queries need no model** (#1785). The index job embeds the
  queries the profile names (site-search: the approved popular queries,
  the suggestions, the pinned results' queries) and the release carries
  their vectors, so a visitor who follows a link to a search or picks a
  popular query is answered before any model loads.

Later queries reuse the loaded model and an LRU of query vectors.

## One text per run

The catalog's exports are dynamically quantised: each layer scales its
activations by the minimum and maximum of the whole input tensor. A padded
batch would make a text's vector depend on its neighbours. Measured on the
default model, the same passage alone and in a batch agree to cosine 0.976 on
average.

`createEmbedder` therefore runs one text per call. A vector is then a function
of its text. The gateway's query (always alone) meets the index under the same
conditions, native and WebAssembly agree to 0.996 on average, and a rebuild
reproduces the old vectors. With intra-op threads this costs no throughput.
It is also what lets the index job keep a passage's vector while its text
stays the same (`packages/collection-index/src/vector-pool.ts`).

## Through a Stage

1. **The Stage reads the model.** After the build, `collections/stage.ts`
   reads each collection's `vectorModelConfig` leaf on main (the state the
   Stage built). A model the catalog does not have fails that plugin's index
   with the step to take.
2. **`collections.finish_stage` records it.** The model goes into
   `collection_releases.vector_model` (migration 0725). If the model differs
   from the previous release's, the release is not carried over.
3. **The index job embeds.** `collections/index-job.ts` embeds new and changed
   passages when the task names a model *and* the search profile has
   `semantic` on, and records the fingerprint. A release built with another
   model, or none, is rebuilt rather than extended. Its stats say
   `vectorModel`, `passagesEmbedded` and `embedSeconds`.
4. **The gateway searches.** `apps/api-gateway/src/collections.ts` embeds the
   query, ranks passages by cosine similarity (at least the profile's
   `minSimilarity`) and fuses the result with the word ranking by Reciprocal
   Rank Fusion (k = 60, the vector side weighted by `semantic.weight`).
   - A document found only by meaning shows its closest passage as the
     snippet.
   - Boosts and best bets apply to the fused order; facets count word matches.
   - A release whose model this gateway's catalog lacks answers
     `503 ModelUnavailable`, never a search with its meaning half missing.

## Tests

- `packages/models`: file verification, the fetcher, the Rust-reference
  tokenizer test, determinism, and native/WebAssembly agreement.
- `packages/collection-index/src/semantic-parity.test.ts`: passages native,
  queries WebAssembly, on the labelled set. It fails when top-1 agreement
  drops under 95 %, or the hybrid MRR under 0.85 or under the word search
  plus 0.15.
- `packages/admin-core/src/collections/index-job.test.ts`: when the job embeds,
  and that a model change rebuilds.
- The Stage test (`collections-stage.integration.test.ts`) and the gateway
  test (`collections.integration.test.ts`) run semantic search end to end.
- The images' smokes embed a probe with every catalog model from the code
  each image runs: the gateway's bundled `image-self-check.js` on
  WebAssembly with the image's `CAELO_ORT_WASM_DIR` (`release-images.yml`),
  and the admin's built server chunks on both runtimes, which must agree
  (`packages/models/scripts/bundle-self-check.ts`, the `admin-prod-image`
  job in `ci.yml`). A check from source would pass while the bundle fails.

Tests that load a model run when `CAELO_MODELS_DIR` holds it, and skip with a
warning otherwise. CI fetches the models through
`.github/actions/embedding-models` (an actions/cache entry keyed by the
catalog, still verified) and sets `CAELO_MODELS=required`, which turns a
missing model into a failure.

In a checkout:

```sh
bun run models:fetch                 # into ./.caelo-models (or $CAELO_MODELS_DIR)
export CAELO_MODELS_DIR=$PWD/.caelo-models
```

## Adding or replacing a model

1. Add the candidate to `packages/collection-index/bench/semantic-candidates.ts`
   (the publisher's own ONNX export, pinned) and run the bench (see
   `semantic-results.md`).
2. If it earns its place, add the catalog entry. Every hash comes from the
   files you measured, never from memory.
3. Record the Rust-reference token ids for its tokenizer
   (`packages/models/src/__fixtures__/reference-tokens.py`) and add a fixture
   test.
4. A replaced model changes every index that uses it at the next Stage (full
   re-embedding, about 35 minutes for 50,000 pages on 4 vCPUs). Say so in the
   release notes.
