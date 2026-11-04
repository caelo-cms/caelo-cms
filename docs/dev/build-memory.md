# Build memory: Stage and Publish live without the site in memory (#1271)

On 2026-10-30 a 2 GiB admin on Cloud Run was OOM-killed while staging 122 pages. The build held every composed page until the end. It copied every referenced image and variant into the build directory, and `/tmp` is memory on Cloud Run. The Firebase publisher then gzipped every file of the build at once and kept all the bodies in the heap. Memory grew with the site, so a bigger instance would only have moved the limit.

The rule since #1271: **build memory is a batch of pages plus a small record per page, whatever the size of the site.** Media and font bytes never pass through the build.

## The generator (`apps/static-generator/src/generate.ts`)

- **Page batches, written in chunks of HTML.** `page-batch.ts` loads `PAGE_BATCH` (200) pages at a time: their placements, content variants (#592), nested modules and plugin list sources. The batch's pages are then composed one by one, and every `CHUNK_HTML_CHARS` (8 MB) of composed HTML the chunk goes through every per-page pass (media, SEO, plugin render, plugin assets, minify, write) and is released. Small pages still go 200 at a time; large pages go a few dozen at a time. Templates and layouts are loaded once, not repeated in every page row.
- **Per-page records, not pages.** Later steps need something from every page: the sitemap, the routing manifest, render deps, link warnings, output-path collisions and the parity digests. Each of these keeps a small record per page. `prepareSeoPass` (`seo-pass.ts`) loads the SEO rows, plugin contributions and public URLs once. It applies them per batch and writes `sitemap.xml` at the end. The render-failure gate collects failure lines (`renderFailuresOf`), not HTML. Composing continues after a failure so the error names every failure, but nothing more is written.
- **Media by stored digest.** `MediaPass` (`media-pass.ts`) resolves each media ref once, in one statement per batch. It names each file from `media_variants.content_sha256` (migration 0452) and never reads it. How the files reach the site depends on `mediaDelivery`:
  - `reference` (Firebase, GCS): each file is listed in `_caelo-asset-references.json` with its stored digests and storage key. A `stat` is the only check the build does on it.
  - `link` (self-hosted): each file is hard-linked into the build. The kernel copies it across filesystems. `syncContents` skips a content-hashed file that `current/` already has at the same size.
- **Fonts** are referenced the same way (`font-assets.ts`). A file's digests are taken once and kept next to it in the fonts cache (`<file>.digest.json`).
- **No second read of the build.** Since #1330 every build renders the live host and Publish live copies it, so no parity digest is taken; the staging slot sync hashes each file as the upload already has it in hand.
- **Parallel where the CPU is.** Minification runs through esbuild's service, so every distinct body of a batch is minified at once on all cores. Files are written 32 at a time. Composition itself is about 0.1 ms per page and stays on the main thread.

- **Files go where they are served, as they are written** (`build-output.ts`).
  - Self-hosted serves the build directory, so the build is written there (`DiskOutput`).
  - On an uploading publisher (Firebase, GCS), the generator hands each file to the admin over its stdio as it is written (`StreamOutput`), and the publisher's `BuildUpload` puts it into the provider's staging version right away. At most 64 files and 8 MB are unacknowledged at a time.
  - Nothing of the site lands on the admin's disk, which on Cloud Run is memory. Only the build's description stays local: the asset references, the parity digests and the render deps of the target.
- **A full garbage collection after every chunk.** The engine grows its heap with the allocation rate. Without the collection, the resident peak grew with the site although the live heap did not: 189 → 381 MB from 1k to 10k pages. With it, the peak goes from 129 to 170 MB, at about 10 ms per chunk spread across all cores.

## Large pages: the template engine and the chunk size (searchVIU, 2026-11-01)

The searchVIU admin (2 GiB, v0.11.7) was OOM-killed staging 162 English pages of ~280 KB: inline SVG illustrations, data-URI images, a script and a stylesheet per module. The generator peaked at 1.3 GB, next to an admin that sat at 0.6–1.3 GB itself. The #1271 fixtures did not show it: their pages are a few KB and render one identical module text on every page. Three causes:

- **Mustache's parse cache kept every render, in both processes.** Mustache caches the parsed tokens of every template text it renders, for the life of the process, and never evicts. The engine (`packages/shared/src/template-engine.ts`) hands it a different text on every call: its sentinels carry a per-call UUID, and list entries, nested modules and link references are pasted in before Mustache runs. So the cache never hit and kept every module of every page, ~30x its size. In the generator that grew the peak by ~3 MB per page. In the admin it kept every page that Live Edit, `inspect_page_render`, screenshots and the editor preview ever rendered: 2.5 GB after previewing 400 pages of the fixture below. The engine turns the cache off (`Mustache.templateCache = undefined`).
- **Mustache's parser allocates per character.** Before it squashes them, `parseTemplate` creates a token array for every character of literal text, so a module's 30 KB SVG was 30,000 arrays of garbage on every render. `shieldLiteralText` replaces each run of 256+ characters without `{`, `}` or a newline by an opaque key before Mustache parses, and puts it back right after. The output is unchanged (`template-engine-memory.test.ts` pins it against Mustache), and `renderTemplate` got about 5x faster on such modules.
- **A batch of 200 large pages is a lot of HTML.** Composing and rewriting a page (slot fills, head injections, media, SEO, plugin passes, minify) allocates about 10x its HTML in short-lived copies, and the engine collects them late. So the peak followed the HTML composed between two collections, which is 200 pages × page size. With `CHUNK_HTML_CHARS`, it follows a fixed 8 MB.

Measured with `stage-memory-rich-pages.integration.test.ts` (fixture pages of ~230 KB, `fixtures/rich-site.ts`), generator peak RSS:

| Pages | Before | After |
|---|---|---|
| 60 | 459 MB | 348 MB |
| 162 | 816 MB | 364 MB |
| 400 | 1,289 MB | 375 MB |

The admin's live heap after previewing all 400 pages: 2,487 MB before, 7 MB after.

`_caelo-asset-references.json` and `_caelo-parity.json` are `BUILD_INTERNAL_FILES`. No publisher serves them.

## Stored digests (`media_variants`, migration 0452)

`content_sha256` names the file. `gzip_sha256` and `gzip_size` are what Firebase Hosting knows the file by (`populateFiles`). `digest_profile` fingerprints the gzip that produced them (`published-digest.ts`), because a zlib upgrade can change gzip output. These are derived state (#1267 rule 3):

- **Write.** `runMediaPipeline` and the favicon rendition return each variant's digests. `media.upload` requires them, and `media.regenerate_variants` and `ensureFaviconRendition` store them.
- **Backfill and rebuild.** `media.rebuild_digests` handles both. It is system-only: no person or AI needs to call it. With scope `missing`, it digests the rows that have no digests or another profile's digests. Every Stage and Publish live rebuild runs it before the generator, the way the favicon rendition is made. With scope `all`, it recomputes every row and reports the rows it corrected. It runs step by step: files are read outside any transaction, streamed, 16 at a time.
- **Consistency.** `packages/admin-core/src/__tests__/media-digests.integration.test.ts` checks that every write path stores the digests of the file it stored.

A build that meets a row without digests fails and names the op. A build never digests a file on the fly.

## The publishers

All three publishers follow the same rule. AWS and Azure keep refusing until their publishers exist (#749/#750).

| Publisher | Built files (HTML, CSS, JS, manifests) | Referenced media and fonts |
|---|---|---|
| Firebase | The version is created when the build starts. Each file is gzipped and hashed as it arrives. `populateFiles` runs per batch of 250, the files Hosting lacks are uploaded (50 at a time), and then the batch is dropped. The config (redirects, rewrites, headers) is set when the version is finalized (`updateMask=status,config`, as firebase-tools does), because the redirects need every served path. | Named by `gzip_sha256` in batched `populateFiles` calls. Only the hashes Hosting lacks are streamed from the store, gzipped on the way, with `Content-Length` set to the stored `gzip_size`. Bytes that no longer match the stored digest fail with the repair. |
| GCS | CRC32C of the bytes in hand against the live manifest. A file that differs is saved under the run's prefix as it arrives. | A path the live bucket already has is skipped: the name carries the content hash. The publisher streams the rest from the store into the staging prefix. |
| Self-hosted | Linked or copied into `current/`. | Hard links in the build (the `link` delivery). |

Only referenced files reach a provider. Staging and live therefore never serve a media file their pages do not use.

## Measuring

Every Stage phase in `deploy_runs.phase_timings` carries two measurements next to its wall time `ms`:

- `peakRssMb`: the process's peak resident memory during the phase.
- `cpuMs`: the process's CPU time during the phase, user plus system, counting every thread (zlib and the other runtime workers). `cpuMs / ms` is how many cores the phase kept busy.

The admin's phases are measured in the admin, and the generator's phases (`generator.*`) in the generator subprocess (`PhaseTimer.withMemory()`, `packages/shared/src/phase-timer.ts`). The generator also reports its whole-run peak (`peakRssMb` in its done event). Composition stays single-threaded: it measures about 0.075 ms per page.

- `packages/admin-core/src/__tests__/build-memory.integration.test.ts` stages 1k and 10k pages with media through the real generator, which streams into the Firebase publisher. It asserts:
  - both RSS peaks stay flat;
  - the 10k Stage sends no media byte;
  - the bytes the build ever had on disk (tmpfs on Cloud Run) stay below 1 KB per page, where the HTML alone is about 2.8 KB per page.
- `packages/admin-core/src/__tests__/stage-memory-rich-pages.integration.test.ts` stages 220 and 440 pages of ~230 KB (`RICH_PAGES` overrides the sizes; keep both above `PAGE_BATCH`, or the comparison measures how full the first batch is). It asserts that the generator's peak grows by less than 100 MB between them, and that previewing every page in the admin keeps less than 24 MB of live heap.
- `packages/admin-core/src/__tests__/stage-scale.bench.ts` is the per-phase benchmark, with `BENCH_PAGES` and `BENCH_MEDIA`. Run it only against a throwaway database (see its header).

## What still grows with the site

These are small records per page: the list render data (the page index that page queries read), the link index, SEO rows and public URLs, render deps, output paths and parity digests. At 10k pages they come to about 30 MB of live heap. On disk, the parity digests and the render deps take a few hundred bytes per page.

When a consent plugin withholds modules, the deferral check loads the content values of one module at a time, so the largest module's content is in memory at once. Without such a plugin, nothing is loaded for the check.
