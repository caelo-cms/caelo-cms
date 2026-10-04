# Private plugin image generation

The `image_generation` capability exposes `ctx.images.describe/get/generate` to
an authenticated author. It requires `private_files`; release-signed and reviewed
external plugins use the same interface. External packages need exact,
version-bound installation receipts. Deno receives neither provider credentials
nor unrestricted network access. Visitor invocations and read-only previews never
receive the image handle.

The host resolves the encrypted Google key and configured native image model.
The adapter uses the installed AI SDK, zero automatic retries, a 180-second
provider deadline and bounded prompt/reference/output sizes. PNG/JPEG/WebP
references are loaded by immutable private-file identity, decoded and normalized
in the host. At most four references and 20 MB total input are accepted. Results
are original-resolution flattened sRGB JPEGs in private file storage; they are
never published to the media library or CDN. The service has no book, scene,
page, PDF, or export concepts.

`requestId` is scoped to the installation and immutable for the exact request.
The broker commits a request ledger entry and a conservative AI-call reservation
before making the paid call. Plugin reservations serialize under one advisory
lock, checking the existing global/actor/session image budgets and plugin spend
cap against the reservation. Existing `ai_calls` history participates in the
checks; in-flight reservations are visible to cost queries. Results update the
estimate using SDK token usage, priced conservatively at the image output rate.
Unknown usage and uncertain outcomes retain the reservation. These are cost
estimates, not billing statements. Pricing was checked against Google's official
pricing page on 2026-09-14; only the bounded supported model set is accepted.

Parallel retries of the same ID produce at most one provider call. A repeated ID
with different inputs fails. `get` lets a plugin recover a completed response
after losing its RPC response. An interrupted/failed/expired request is reported
as running or uncertain and is never automatically paid again. An interruption
between a provider response and durable storage cannot guarantee recovered bytes;
this is exposed as uncertain, not silently retried. Cancellation of a plugin's
queue does not cancel a request that has already reached the provider.

Author permissions are checked on every call. The ledger is shared with the
chat's `generate_image` (#527): `plugin-host/src/image-ledger.ts`, wrapped as
`plugin_images.read / reserve / finish / mark_uncertain` here and as
`image_requests.*` for the chat. `reserve` checks the `image_generation` receipt
for exactly the running artifact, then every image budget and the plugin's cost
cap in one transaction, serialised against all other reservations (chat and
plugins alike). The provider call holds no DB transaction. Results are stored
through `ctx.privateFiles`, which checks its own grant. The table is
`image_requests` (migration 0226, formerly 0222's `plugin_image_requests`):
plugin rows stay host-only under forced RLS; chat rows are readable as the
site's own provenance.

Each request records its provenance (#532): prompt, references (id + sha256),
what was requested and the model. `get` and repeated `generate` calls return it
as `provenance`. `edit()` (#528) changes a private image (`source`) into a new
private file through the same ledger; a `mask` PNG limits the change on models
whose capabilities report `mask: true` (Gemini does not — the request is refused
before anything is reserved). `describe()` returns the model's `capabilities` (#529) —
operations, reference limits, mask support, sizes and resolutions — from the
same model profiles the chat uses (`admin-core/src/ai/image-models.ts`), which
also hold the prices.

Large reviewed bundles are bounded to 4 million source characters (16 MB UTF-8),
20 MB installation uploads, 256 MiB Deno heap, 1024 SDK calls and 1 MiB RPC messages.
Image-capable invocations have a 240-second overall deadline; other invocations
retain 30 seconds. No sandbox permission is relaxed. A single private file remains
limited to 20 MiB and the installation quota remains 1 GiB.

Tests exercise real PostgreSQL and Deno: concurrent idempotency, separate-plugin
privacy, references, visitor/preview denial, cost attribution, uncertain outcomes,
plugin budget denial and live grant revocation. The independently built Pictbook
integration additionally creates a 24-page book and both PDF exports through the
SDK using a deterministic local image-provider test double. Live Google acceptance
is a separate opt-in browser run with an explicit fictional payload and budget.

Compressed `.json.gz` and `.json.br` uploads decode with a 20 MB output bound before normal
artifact validation. This allows library bundles such as Pictbook to fit the
Bun adapter's default 512 KB request limit without raising it globally. Larger
raw or compressed uploads still require the operator's existing body limit to
permit their transport size. No archive paths are extracted.

`images.transform({source:{id,sha256},width,height,quality})` creates a local
JPEG derivative without contacting a provider or changing the original. The
host accepts only private PNG/JPEG/WebP, bounds decoding to 40 million pixels,
limits dimensions to 8192 and quality to 60–95, fits inside the requested size
and never upscales. Output is flattened sRGB; its content-derived private-file
identity makes repeated exports reuse stored bytes. The normal file/quota and
author/grant checks remain active. Pixel selection belongs to the plugin; the
host has no print-resolution policy. Integration tests verify Deno dispatch,
repeat identity, zero extra paid calls, no upscaling, cross-plugin denial,
forged hashes, excessive dimensions and absence in preview contexts.
