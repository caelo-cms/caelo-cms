# Embedding models for semantic search: measurements (#1650)

Measured 2026-11-21 on an Apple M3 Pro (macOS, Bun 1.4.4, ONNX Runtime 1.31.1
native and WebAssembly) with `bench/semantic.ts` on the labelled set in
`bench/semantic-corpus.ts`: three small sites (a SaaS product, a town's citizen
services, an outdoor shop; 40 pages, 77 sections, German with some English
pages) and 77 queries written the way visitors type them. Twelve use the
page's own words, 37 paraphrase the need ("Kosten" for a price page), 10 are
questions, and 18 have their only answer in the other language. Each query is
searched within its site; a page ranks by its best section. MRR@10 is the
headline number. On this set one query more or less in first place moves it
by 0.013, so differences under about 0.02 are a tie.

Every model ran in its publisher's own quantised ONNX export (the fp32 row is
for comparison). Passages ran on native ONNX Runtime, as the index job runs
them. Queries ran on WebAssembly, as the gateway runs them. Vectors go through
the engine's int8 store and binary candidates. The fused rows ("hybrid") add
the engine's word search with Reciprocal Rank Fusion (k = 60), the way the
gateway answers when a profile turns semantic search on. Latency and memory
come from a fresh process per model and runtime, one thread unless stated.

## Quality

The engine's word search alone scores **0.656** (cross-language **0.222**).

| Model | Licence | Files (MB) | Quant. | Hybrid MRR@10 | Vector MRR@10 | Cross-language (vector) | Paraphrase (hybrid) | R@1 hybrid |
|---|---|---|---|---|---|---|---|---|
| multilingual-e5-small | MIT | 135 | qint8 | 0.849 | 0.776 | 0.692 | 0.849 | 0.78 |
| paraphrase-multilingual-MiniLM-L12-v2 | Apache-2.0 | 127 | qint8 | 0.905 | 0.813 | 0.866 | 0.881 | 0.84 |
| **granite-embedding-97m-multilingual-r2** | Apache-2.0 | 124 | quint8 | 0.897 | 0.833 | 0.894 | 0.850 | 0.82 |
| granite-embedding-97m-multilingual-r2 | Apache-2.0 | 415 | fp32 | 0.922 | 0.874 | 0.935 | 0.896 | 0.86 |
| multilingual-e5-base | MIT | 296 | qint8 | 0.859 | 0.769 | 0.673 | 0.866 | 0.79 |
| snowflake-arctic-embed-m-v2.0 | Apache-2.0 | 328 | int8 | 0.939 | 0.898 | 0.944 | 0.919 | 0.88 |

## Speed and memory

| Model | WASM load (ms) | WASM query p50 / p95 (ms) | WASM RSS (MB) | Native query p50 / p95 (ms) | Native RSS (MB) | Passage native / WASM (ms) | Index throughput, 1 / 4 threads (passages/s) |
|---|---|---|---|---|---|---|---|
| multilingual-e5-small | 413 | 10.3 / 15.3 | 688 | 2.1 / 3.3 | 458 | 37 / 173 | 64 / 159 |
| MiniLM-L12-v2 | 427 | 6.7 / 12.1 | 672 | 1.6 / 2.6 | 725 | 35 / 169 | 69 / 176 |
| **granite 97M r2 (quint8)** | 478 | 9.9 / 16.4 | 569 | 2.1 / 3.4 | 318 | 43 / 230 | 55 / 143 |
| granite 97M r2 (fp32) | 771 | 8.2 / 14.8 | 1750 | 5.5 / 10.0 | 1648 | 115 / 221 | 22 / 70 |
| multilingual-e5-base | 670 | 38.3 / 59.4 | 1098 | 6.7 / 9.8 | 1331 | 112 / 636 | 21 / 65 |
| arctic-embed-m-v2.0 | 575 | 48.0 / 75.3 | 1478 | 9.0 / 13.8 | 1496 | 133 / 799 | 17 / 52 |

"Load" is the time from a cold process to an embedder that answers. It
includes re-hashing both files (SHA-256), parsing the tokenizer and creating
the session. "Passage" is one section of about 130 tokens. RSS is the growth
of the process's resident memory once the model is loaded and has answered
queries.

## Native against WebAssembly (the parity the gateway depends on)

| Model | min cos | mean cos | top-1 agree | top-5 overlap | MRR, native queries | MRR, WASM queries |
|---|---|---|---|---|---|---|
| multilingual-e5-small | 0.9963 | 0.9996 | 100 % | 100 % | 0.780 | 0.778 |
| MiniLM-L12-v2 | 0.9909 | 0.9995 | 98.7 % | 100 % | 0.819 | 0.813 |
| **granite 97M r2 (quint8)** | 0.9778 | 0.9986 | 100 % | 99.7 % | 0.828 | 0.828 |
| granite 97M r2 (fp32) | 1.0000 | 1.0000 | 100 % | 100 % | 0.861 | 0.861 |
| multilingual-e5-base | 0.9834 | 0.9978 | 98.7 % | 99.0 % | 0.779 | 0.775 |
| arctic-embed-m-v2.0 | 0.9900 | 0.9981 | 100 % | 98.2 % | 0.898 | 0.898 |

## One text per run, not padded batches

The quantised exports are *dynamically* quantised: each layer scales its
activations by the minimum and maximum of the whole input tensor. A padded
batch therefore changes every text's vector. On Granite 97M, one text alone
and the same text in a batch of 40 agree only to cosine **0.976** on average
(0.965 at worst). Alone on native and alone on WebAssembly agree to **0.996**
(0.987 at worst). The thread count changes nothing (1.0000). The fp32 graph
is unaffected (1.0000 everywhere).

So the embedder runs one text per call (`packages/models/src/embedder.ts`).
A passage's vector is then a function of its text: the gateway's query
(always alone) meets the index under the same conditions, and a rebuild
reproduces the old vectors. Nothing is lost by it. With intra-op threads a
single text runs as fast as a batch, or faster, because no compute goes to
padding:

| Threads | One text per run (passages/s) | Batches sorted by length (passages/s) |
|---|---|---|
| 1 | 52.8 | 42.5 |
| 2 | 91.8 | 79.5 |
| 4 | 142.8 | 122.9 |
| 8 | 100.3 | 124.1 |

The M3 Pro has 5 performance and 6 efficiency cores. On a job with dedicated
vCPUs, scaling should go on past 4 threads. At about 140 passages per second
on 4 vCPUs, the first index of 50,000 pages (about 300,000 sections) takes
about 35 minutes. After that, a Stage embeds only new and changed passages.

## WebAssembly under Bun

The only WebAssembly build ONNX Runtime 1.31 ships is SIMD with threads. Its
worker threads run under Bun 1.4.4:

| Threads | Query p50 / p95 (ms) | Passage (ms) |
|---|---|---|
| 1 | 9.9 / 16.4 | 230 |
| 2 | 9.5 / 11.2 | 153 |
| 4 | 5.5 / 8.1 | 82 |

The gateway has one vCPU and asks for one thread.

## The choice: granite-embedding-97m-multilingual-r2 (quint8)

- **Quality:** on the hybrid ranking the gateway serves, it ties MiniLM-L12
  (0.897 against 0.905, less than one query apart) and clearly beats
  multilingual-e5-small and -base. On meaning alone it is the best small
  model (0.833), and the best across languages (0.894; MiniLM 0.866,
  e5-small 0.692).
- **Real pages are longer than these sections:** MiniLM-L12 was trained on
  128 tokens (`max_seq_length` 128) and reads only the first 100 words or so
  of a section. Granite r2 was trained up to 32,768 tokens; the catalog cuts
  at 512 (`maxTokens`). On Multilingual MTEB retrieval, IBM reports 60.3 for
  Granite against 50.9 for e5-small.
- **It fits the gateway:** it is the smallest download (124 MB) and needs the
  least memory on WebAssembly (569 MB). Its query p95 is 16 ms on one thread,
  inside the 30 ms budget on this CPU; Cloud Run's vCPU still has to be
  measured (#1652).
- **Licence:** Apache-2.0, trained on permissively licensed data (IBM model
  card).

**Not chosen:**

- **arctic-embed-m-v2.0** is the most accurate (0.939). But it is 328 MB,
  answers in 75 ms p95 on WebAssembly and needs 1.5 GB: it does not fit a
  one-vCPU, 1 GiB gateway.
- **The fp32 export of Granite** recovers what the quantisation costs (hybrid
  0.922, vector 0.874, exact parity). But it is 415 MB and needs 1.75 GB on
  WebAssembly.

The way to close that gap without the size is a weight-only int8 export
(MatMulNBits, activations kept in fp32): quality and parity of the fp32
graph, a file the size of the int8 one. It needs an artifact Caelo builds
and pins itself. It is an open point of #1650, not part of this choice.

## Reproduce

```sh
bun run bench/semantic.ts --fetch      # the candidates into $BENCH_MODELS_DIR (about 1.8 GB)
BENCH_MODELS_DIR=<dir> bun run bench:semantic
```

`src/semantic-parity.test.ts` runs the same evaluation for the catalog's
default model in CI. It fails when native and WebAssembly drift apart, or
when the hybrid ranking falls under 0.85 or less than 0.15 above the word
search.
