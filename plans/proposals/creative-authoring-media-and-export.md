# Proposal: reusable media and document export services for authoring plugins

Status: proposed for review; this PR adds no working SDK methods or renderer.

Tracking: [#470](https://github.com/caelo-cms/caelo-cms/issues/470).
External capability grants: [#469](https://github.com/caelo-cms/caelo-cms/issues/469).

Baseline inspected: `6d4d2dd9debba856286ff769b62cd2c17584cac3`.

## Outcome

An author asks [Pictbook](https://github.com/caelo-cms/pictbook) to create an
illustrated book, revises one scene without losing the others, and exports the
selected revision as a print manuscript and cover. The plugin owns books,
characters, storytelling, layouts and print profiles. Caelo supplies reusable
media, authoring revision, job and artifact services through its public SDK.

This proposal complements the external-plugin capability-grant proposal. It is
useful to bundled plugins too; granting external plugins today's SDK alone does
not supply these missing primitives.

## Verified gaps and existing work

| Area | Current source evidence | Required addition |
| --- | --- | --- |
| Image generation | `packages/admin-core/src/ai/tools/generate-image.ts` persists generated media. | A host service usable by both chat tools and plugins. |
| Image references/editing | `ImageRequest` in `packages/admin-core/src/ai/image-provider.ts` has text, size and quality, but no reference images or edit mask. | Reference-media and editing contracts with explicit provider capability discovery. |
| Plugin AI | `PluginAi` in `packages/plugin-sdk/src/index.ts` exposes text `complete` only. | Image operations without exposing API keys or requiring imports from admin-core. |
| Private authoring state | `PluginAdminQuery` offers CRUD; `PluginSnapshots` exposes separate snapshot emission. | A documented atomic, branch-aware mutation/revert contract for plugin-owned entities. Do not assume independent CRUD plus `emit` achieves this. |
| Jobs | Plugin workers declare a cron and operation. | A public durable job contract for progress, retry, cancellation and pinned inputs. |
| Print output | No PDF/artifact service is exposed by the inspected plugin SDK. | A bounded host renderer and private artifact persistence/download API. |

Coordinate with [#39](https://github.com/caelo-cms/caelo-cms/issues/39) (image
workflow/budgets), [#40](https://github.com/caelo-cms/caelo-cms/issues/40) (provider
SDK migration), [#428](https://github.com/caelo-cms/caelo-cms/issues/428) (production
Chromium), [#447](https://github.com/caelo-cms/caelo-cms/pull/447) (data lists), and
[#456](https://github.com/caelo-cms/caelo-cms/pull/456) (client assets).
Do not assume an open PR or a locally installed browser is a production feature.

## 1. Media service shared by the chat and SDK

Proposed operation shapes, not callable APIs today:

```text
media.capabilities() -> supported operations, reference/mask limits, sizes
media.generate({ prompt, referenceMediaIds, requestedSize, idempotencyKey })
media.edit({ sourceMediaId, maskMediaId?, prompt, referenceMediaIds, idempotencyKey })
  -> jobId
media.inspectMany({ mediaIds })
  -> dimensions, original/derivative ids, provenance, access, available formats
```

The host resolves asset IDs under the initiating actor and branch, reads original
bytes, invokes the configured provider, and persists results before returning
durable media IDs. No arbitrary caller URL fetching; no provider secrets or
expiring provider URLs in plugin state. Treat every provider output as untrusted
input, with MIME/size/dimension checks and bounded decoding.

Extract the existing tool implementation into a host-owned service injected into
plugin-host. Keep dependency direction intact: plugins import SDK contracts,
plugin-host receives interfaces, admin-core wires the implementation. Both the
chat tool and SDK go through the same budget, audit and media persistence path.

Use the provider SDK's supported image/multimodal interfaces per `CLAUDE.md` §12;
coordinate with #40 rather than adding a parallel raw-HTTP adapter. Verify actual
SDK/provider support during implementation. Unsupported reference/edit/size
requests fail with a structured actionable error; never silently drop reference
images or substitute a smaller size.

Persist generation provenance: prompt, reference asset revisions, provider/model,
requested and actual dimensions, derivative lineage and actual recorded cost.
An upscale is identified as a derivative, not a new native-resolution original.
This information supports Pictbook's own per-page consistency and print checks.
References improve control; the API does not promise identical characters.

Reserve budget atomically before paid dispatch and settle actual usage afterward.
Concurrent jobs share site and per-plugin limits. Idempotency is scoped to the
installation and input digest: changed inputs under the same key are rejected.
An ambiguous provider timeout is recorded as uncertain, not blindly billed again.

Expose distinct grants for media read, generation/editing and artifact creation
using the capability catalog from the grants proposal. Granting text AI access
must not silently expand to new paid image operations on upgrade.

## 2. Authoring revisions and durable work

Pictbook needs private book drafts, not publicly queryable visitor tables. The
implementation must choose and prove one supported storage route:

1. Reuse existing branch-aware core content entities through Query API if they
   preserve a complete book and its atomic edits without per-page partial state.
2. Otherwise extend plugin-private authoring storage with host-owned versioned
   entities, atomic bulk mutation and snapshot/revert integration.

Recommended contract for the second route: a host-validated document schema and
`mutateMany` operation carry expected revision IDs. One transaction updates the
documents and emits their snapshots with host-supplied chat/task/branch identity.
The host supports load, branch merge, conflict reporting and restore for the
declared schema version. Plugin executable callbacks do not run inside the DB
transaction. Snapshot writes must not be a later best-effort RPC.

Conflicting edits fail with revision details; two chats cannot overwrite each
other. Snapshot schema migration and retention are explicit. This contract must
include isolation and restore tests before Pictbook uses plugin-private tables
for manuscript state. An audit log alone is not undo.

For long-running operations, extend existing worker infrastructure with durable
jobs rather than building a Pictbook-specific scheduler in core:

```text
job = { installationId, artifactDigest, grantRevision, actorScope,
        branchId, inputRevisionId, inputDigest, idempotencyKey,
        status, progress, attempt, lease, resultArtifactIds, error }
status = queued | running | succeeded | failed | cancelled | needs_reconciliation
```

Workers claim leases and checkpoint output per item. Retry only failed/known-safe
items, bound attempts and concurrency, and resume after restart without generating
completed images again. Expired leases cannot authorize duplicate final commits.
Recheck grants when claiming work and before committing results. Cancellation
prevents new dispatch; an already accepted provider request may still incur cost.

When a character/style/page changes during generation, finish against the pinned
revision and mark the output as an unapplied candidate. Never attach old output
to a new page silently. Applying candidates is an atomic revision-checked edit.
Expose list/get/cancel operations so the AI can report real progress on demand.

## 3. Deterministic document rendering and private artifacts

Proposed host operation:

```text
documents.renderPdf({ documentRevisionId, renderSpec, idempotencyKey }) -> jobId
artifacts.get({ artifactId }) -> metadata and an authorized download
```

The render spec is a versioned, bounded scene description: page dimensions and
boxes in points (72 per inch), ordered text/image/vector elements, embedded font
asset IDs, explicit crops and color/output settings. Layout is resolved before
rendering; text overflow is an error. Pictbook maps its book layout to this generic
format. Caelo does not gain book, character, Amazon or ISBN tables.

The renderer uses immutable asset/font revisions and a pinned engine version.
No arbitrary JavaScript, external URLs, shell commands or plugin-provided renderer
binaries. Run the renderer in an isolated host-managed worker with memory/time/
page-count/asset-size limits. Fonts and images resolve through authorized storage.
Record the resolved manifest, hashes and engine version for reproducibility.

Prefer a declarative PDF engine for the first print pipeline. Select its exact
version/license only after a proof demonstrates font embedding, text shaping,
page boxes and color handling. Browser printing is a possible adapter, not an
assumed dependency: #428 is evidence that development browser availability is
insufficient. Every deployed runtime must package and smoke-test its renderer.

Artifacts are immutable and private by default, with installation/actor access,
content hash, source revision, renderer/profile version, byte size and MIME type.
Unpublished manuscripts and covers never appear in public media lists or CDN
manifests. Downloads authorize each request or issue short-lived signed links.
Treat rendered PDFs as downloads, never executable admin content.

Define retention/quotas and clean abandoned temporary objects. Published exports
pin the necessary revision assets; deleting a draft cannot invalidate an existing
export unexpectedly. Disabling a plugin preserves downloadable artifacts subject
to the existing user's authorization and retention policy.

## 4. Print rules belong to Pictbook

Pictbook owns versioned print profiles and validates the selected binding,
marketplace, trim, color/paper choice, page count, bleed and safe areas. It exports
`interior.pdf`, `cover.pdf` and a preflight report for the same frozen revision.
The core PDF service knows geometry and fonts, not KDP policy.

Amazon requires single-page interiors rather than two-up spreads and at least
300 DPI images at print size. Its guidelines also require embedded fonts and
constrain file size and PDF content. Validate these in the plugin's print profile.
[Paperback submission guidelines](https://kdp.amazon.com/en_US/help/topic/G201857950)

The cover is a separate wrap containing back, spine and front; dimensions depend
on final pagination and paper/ink choice. Use the applicable calculator/template
for the profile, not a hardcoded spine width.
[Paperback cover guide](https://kdp.amazon.com/en_US/help/topic/G201953020)

Sources checked 2026-09-06. A passing preflight means the implemented profile
checks passed, not that Amazon accepted the upload. Acceptance evidence includes
a manual KDP Print Previewer pass and a physical proof of a representative book.

## Delivery and verification

| Slice | Required evidence |
| --- | --- |
| Shared media service + reference/edit support | Same persisted output path for chat and plugin; unsupported capabilities are explicit; reference ownership checked; concurrent budget cap tested. |
| Revision contract | Real-Postgres atomic bulk edits, two-chat isolation, conflict and complete undo/restore tests; no partial book state. |
| Durable jobs | Restart/lease expiry/cancel/revoke tests, duplicate-key conflicts, uncertain provider outcome handling and no stale result application. |
| PDF + artifacts | PDF parser checks of boxes, page count and embedded fonts; overflow and low-resolution rejection; private downloads; production container smoke test. |
| Pictbook vertical flow | Real CMS E2E: install external bundle, approve grants, create book, revise one scene, restart/resume work, export a frozen revision and download both PDFs. |

Use deterministic fixtures for routine automated tests and a separately budgeted
real-provider acceptance run for reference fidelity. Track individual implementation
slices under the proposal issue; each runtime PR ships its matching tests and docs.
No new dependency is introduced by this design PR.
