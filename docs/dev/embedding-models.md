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
- every file by SHA-256 and size (the ONNX graph and `tokenizer.json`);
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
chose it. Every entry ships in both images (about 125 MB each), so a model
joins only when a measurement shows that sites need what the default cannot
do.

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

Both runtimes are 1.31.1 (MIT). The tokenizer is `@huggingface/tokenizers`
0.2.0 (Apache-2.0, pure JavaScript). `packages/models/src/model.test.ts`
compares its token ids with ids recorded from the Rust reference
(`src/__fixtures__/`).

How each image carries the runtimes:

- **Gateway.** The image bundles ONNX Runtime's JavaScript.
  `apps/api-gateway/image.ts` stages only `ort-wasm-simd-threaded.{wasm,mjs}`,
  loaded from `CAELO_ORT_WASM_DIR`. The SBOM lists each model as
  `pkg:huggingface/<repo>@<revision>`.
- **Admin.** The Dockerfile drops every native library but linux x64 and
  every WebAssembly build but the SIMD one. That removes about 400 MB of the
  435 MB the two packages install.

Memory and speed of the default model (M3 Pro, one thread):

| | Query p50 / p95 | Memory |
|---|---|---|
| Gateway (WebAssembly) | 9.9 / 16.4 ms | about 570 MB |
| Index job (native) | about 140 passages/s on 4 threads | about 320 MB |

**A gateway that serves a semantic collection needs 1 GiB.** It loads the
model when it first opens such a release, not at boot. The first semantic
query of an instance waits about half a second for the load; later queries
reuse an LRU of query vectors.

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
