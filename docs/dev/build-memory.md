# Build memory: Stage and Publish live without the site in memory (#1271)

On 2026-10-30 a 2 GiB admin on Cloud Run was OOM-killed while staging 122 pages. The build held every composed page until the end. It copied every referenced image and variant into the build directory, and `/tmp` is memory on Cloud Run. The Firebase publisher then gzipped every file of the build at once and kept all the bodies in the heap. Memory grew with the site, so a bigger instance would only have moved the limit.

The rule since #1271: **build memory is a batch of pages plus a small record per page, whatever the size of the site.** Media and font bytes never pass through the build.

## The generator (`apps/static-generator/src/generate.ts`)

- **Page batches.** Pages are composed, rewritten and written `PAGE_BATCH` (200) at a time. `page-batch.ts` loads each batch's placements, content variants (#592), nested modules and plugin list sources. Each per-page pass runs on the batch: media, SEO, plugin render, plugin assets, minify, write. Then the batch is released. Templates and layouts are loaded once, not repeated in every page row.
- **Per-page records, not pages.** Later steps need something from every page: the sitemap, the routing manifest, render deps, link warnings, output-path collisions and the parity digests. Each of these keeps a small record per page. `prepareSeoPass` (`seo-pass.ts`) loads the SEO rows, plugin contributions and public URLs once. It applies them per batch and writes `sitemap.xml` at the end. The render-failure gate collects failure lines (`renderFailuresOf`), not HTML. Composing continues after a failure so the error names every failure, but nothing more is written.
- **Media by stored digest.** `MediaPass` (`media-pass.ts`) resolves each media ref once, in one statement per batch. It names each file from `media_variants.content_sha256` (migration 0443) and never reads it. How the files reach the site depends on `mediaDelivery`:
  - `reference` (Firebase, GCS): each file is listed in `_caelo-asset-references.json` with its stored digests and storage key. A `stat` is the only check the build does on it.
  - `link` (self-hosted): each file is hard-linked into the build. The kernel copies it across filesystems. `syncContents` skips a content-hashed file that `current/` already has at the same size.
- **Fonts** are referenced the same way (`font-assets.ts`). A file's digests are taken once and kept next to it in the fonts cache (`<file>.digest.json`).
- **Parity digests in the same pass.** `ParityRecorder` (`parity-digest.ts`) hashes each page from the bytes being written. A Stage with its own staging host also hashes the page with that host swapped back to the live one. Referenced files count by their stored hash. The result goes to `_caelo-parity.json`, which `deploy.trigger` and Publish live read (`deploy/build-parity.ts`). No file is read again to fingerprint a build.
- **Parallel where the CPU is.** Minification runs through esbuild's service, so every distinct body of a batch is minified at once on all cores. Files are written 32 at a time. Composition itself is about 0.1 ms per page and stays on the main thread.

`_caelo-asset-references.json` and `_caelo-parity.json` are `BUILD_INTERNAL_FILES`. No publisher serves them.

## Stored digests (`media_variants`, migration 0443)

`content_sha256` names the file. `gzip_sha256` and `gzip_size` are what Firebase Hosting knows the file by (`populateFiles`). `digest_profile` fingerprints the gzip that produced them (`published-digest.ts`), because a zlib upgrade can change gzip output. These are derived state (#1267 rule 3):

- **Write.** `runMediaPipeline` and the favicon rendition return each variant's digests. `media.upload` requires them, and `media.regenerate_variants` and `ensureFaviconRendition` store them.
- **Backfill and rebuild.** `media.rebuild_digests` handles both (AI tool `rebuild_media_digests`). With scope `missing`, it digests the rows that have no digests or another profile's digests. Every Stage and Publish live rebuild runs it before the generator, the way the favicon rendition is made. With scope `all`, it recomputes every row and reports the rows it corrected. It runs step by step: files are read outside any transaction, streamed, 16 at a time.
- **Consistency.** `packages/admin-core/src/__tests__/media-digests.integration.test.ts` checks that every write path stores the digests of the file it stored.

A build that meets a row without digests fails and names the op. A build never digests a file on the fly.

## The publishers

All three publishers follow the same rule. AWS and Azure keep refusing until their publishers exist (#749/#750).

| Publisher | Built files (HTML, CSS, JS, manifests) | Referenced media and fonts |
|---|---|---|
| Firebase | Gzipped and hashed `CPU_PARALLELISM` at a time. The publisher keeps only path and hash, and gzips a file again from disk when Hosting asks for it. | Named by `gzip_sha256` in batched `populateFiles` calls. Only the hashes Hosting lacks are streamed from the store, gzipped on the way, with `Content-Length` set to the stored `gzip_size`. Bytes that no longer match the stored digest fail with the repair. |
| GCS | CRC32C against the live manifest, as before. | A path the live bucket already has is skipped: the name carries the content hash. The publisher streams the rest from the store into the staging prefix. |
| Self-hosted | Linked or copied into `current/`. | Hard links in the build (the `link` delivery). |

Only referenced files reach a provider. Staging and live therefore never serve a media file their pages do not use.

## Measuring

Every Stage phase in `deploy_runs.phase_timings` carries `peakRssMb`. The admin's phases are sampled in the admin, and the generator's phases (`generator.*`) are sampled in the generator subprocess (`PhaseTimer.withMemory()`, `packages/shared/src/phase-timer.ts`). The generator also reports its whole-run peak (`peakRssMb` in its done event).

- `packages/admin-core/src/__tests__/build-memory.integration.test.ts` stages 1k and 10k pages with media through the real generator and the Firebase publisher. It asserts that both peaks stay flat and that the 10k Stage sends no media byte.
- `packages/admin-core/src/__tests__/stage-scale.bench.ts` is the per-phase benchmark, with `BENCH_PAGES` and `BENCH_MEDIA`. Run it only against a throwaway database (see its header).

## What still grows with the site

These are small records per page: the list render data (the page index that page queries read), the link index, SEO rows and public URLs, render deps, output paths and parity digests. At 10k pages they come to about 30 MB of live heap. When a consent plugin withholds modules, the deferral check loads the content values of one module at a time, so the largest module's content is in memory at once. Without such a plugin, nothing is loaded for the check. On uploading publishers the build directory still holds the HTML (Cloud Run: `/tmp`). Writing each file straight to the provider's staging version is the next step for very large sites.
