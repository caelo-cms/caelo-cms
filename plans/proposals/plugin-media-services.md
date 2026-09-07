# Proposal: shared media services for plugins

Status: proposed for review; this PR adds no working SDK methods.

Tracking: [#470](https://github.com/caelo-cms/caelo-cms/issues/470).
External capability grants: [#469](https://github.com/caelo-cms/caelo-cms/issues/469).

Baseline inspected: `6d4d2dd9debba856286ff769b62cd2c17584cac3`.
Scope clarified: 2026-09-07.

## Outcome and ownership

A plugin can generate or edit an image through the same authorized, budgeted
media service used by Caelo's chat. Reference images, capability discovery and
persisted media IDs are useful to website authoring as well as external plugins.

Caelo remains a web CMS. [Pictbook](https://github.com/caelo-cms/pictbook) is one
consumer of these services and owns its entire book domain: drafts, revisions,
undo, characters, page layout, illustration batches, PDF rendering, exports and
KDP rules. Their schemas, workflows, renderer dependencies and tests live in the
Pictbook repository. This proposal introduces no document revision engine, book
job system, PDF renderer or print profile into Caelo.

The external capability-grant proposal enables access to existing general SDK
features such as private plugin data and scheduled operations. If implementing
Pictbook reveals a missing general primitive, propose that narrow primitive with
a reproducible use case; do not prebuild a document-authoring platform in core.

## Verified media gaps and existing work

| Area | Current source evidence | Required addition |
| --- | --- | --- |
| Image generation | `packages/admin-core/src/ai/tools/generate-image.ts` persists generated media. | A host service usable by both chat tools and plugins. |
| Image references/editing | `ImageRequest` in `packages/admin-core/src/ai/image-provider.ts` has text, size and quality, but no reference images or edit mask. | Reference-media and editing contracts with explicit provider capability discovery. |
| Plugin AI | `PluginAi` in `packages/plugin-sdk/src/index.ts` exposes text `complete` only. | Image operations without exposing API keys or requiring imports from admin-core. |

Coordinate with [#39](https://github.com/caelo-cms/caelo-cms/issues/39) (image
workflow/budgets) and [#40](https://github.com/caelo-cms/caelo-cms/issues/40)
(provider SDK migration). Granting external plugins today's SDK alone does not
supply these media operations. The service is useful to bundled plugins too.

## Media service shared by chat and SDK

Proposed operation shapes, not callable APIs today:

```text
media.capabilities() -> supported operations, reference/mask limits, sizes
media.generate({ prompt, referenceMediaIds, requestedSize, idempotencyKey })
media.edit({ sourceMediaId, maskMediaId?, prompt, referenceMediaIds, idempotencyKey })
  -> persisted media IDs and actual output metadata
media.inspectMany({ mediaIds })
  -> dimensions, original/derivative IDs, provenance, access, available formats
```

The host resolves asset IDs under the initiating actor's authorized scope, reads
original bytes, invokes the configured provider, and persists results before
returning durable media IDs. No arbitrary caller URL fetching; no provider secrets
or expiring provider URLs in plugin state. Treat provider output as untrusted input,
with MIME/size/dimension checks and bounded decoding.

Extract the existing tool implementation into a host-owned service injected into
plugin-host. Keep dependency direction intact: plugins import SDK contracts,
plugin-host receives interfaces, admin-core wires the implementation. Both the
chat tool and SDK use the same budget, audit and media persistence path.

Use the provider SDK's supported image/multimodal interfaces per `CLAUDE.md` §12;
coordinate with #40 rather than adding a parallel raw-HTTP adapter. Verify actual
SDK/provider support during implementation. Unsupported reference/edit/size
requests fail with a structured actionable error; never silently drop reference
images or substitute a smaller size.

Persist media provenance: prompt, immutable reference asset identities,
provider/model, requested and actual dimensions, derivative lineage and recorded
cost. An upscale is identified as a derivative. The service does not interpret
book revisions, character identity, print resolution or page numbering.

Reserve budget atomically before paid dispatch and settle actual usage afterward.
Concurrent calls share site and per-plugin limits. Idempotency is scoped to the
installation and input digest; changed inputs under the same key are rejected.
An ambiguous provider timeout is recorded as uncertain, not blindly billed again.
Expose an operation status lookup by idempotency key so the caller can reconcile
an interrupted invocation. This tracks one media request, not a book workflow.

Pictbook owns batch ordering, progress, retry policy, input book revisions and
application of returned images to pages. The media service reports one request's
actual outcome and never attaches an image to a book or decides whether a page
has changed. Long-running provider requests need a bounded transport and durable
request result; an implementation may expose an opaque request ID and polling
without introducing a general document-job engine.

## Permissions and private data

Expose explicit media read and generation/editing grants using the capability
catalog from #469. Granting text AI access must not silently authorize new paid
image operations on upgrade. Recheck authorization before accepting a request
and before persisting or exposing its result. Already-dispatched provider work
may still incur cost after cancellation or revocation; record that outcome.

Validate access to every reference and mask; an asset ID is not authorization.
Persist generated media with the requested authorized visibility rather than
implicitly publishing private inputs or outputs to the public CDN. Keep private
assets out of public lists and manifests. If the existing media storage contract
cannot preserve that distinction, implement narrowly scoped media visibility and
access controls here with regression tests; this is a general CMS media concern.

## What remains in Pictbook

- Book schemas, complete immutable revisions, draft pointers, edit conflicts,
  undo/restore, and the relation between an export and its source revision.
- Character/style references, illustration candidates, batch jobs and their
  progress, resume and cancellation behavior.
- Book preview, page layout, font selection, PDF scene description and rendering,
  cover geometry, KDP profiles and preflight checks.
- Export records, retention rules and selection of revision/media assets to pin.

Pictbook uses approved general persistence and storage interfaces. Caelo's own
page/module snapshots continue to serve website editing. A book is not encoded
as synthetic CMS pages merely to reuse those snapshots. A later website edition
is an explicit publish operation through the existing CMS workflow.

A missing atomic write, conditional update, private binary storage operation or
approved worker execution facility must be demonstrated against the SDK during
implementation and proposed separately if needed. Such an API handles opaque
plugin data or bytes; its contract does not mention books, PDFs, KDP or revision
semantics. No core PDF service is a prerequisite for this media proposal.

## Delivery and verification

| Slice | Required evidence |
| --- | --- |
| Shared media service | Chat and plugin calls use the same provider, persistence, budget and audit path; no dependency cycle. |
| References/editing | Authorized references and masks reach a supporting provider; unsupported operations/sizes fail explicitly. |
| Request lifecycle | Concurrent budget reservations, duplicate-key conflicts, interrupted requests and uncertain provider outcomes have tested behavior. |
| Media visibility | Private input/output ownership checks, public-list/CDN exclusion and denied access after permission revocation. |
| Plugin integration | A granted external plugin can generate/edit media; a plugin without the required grant cannot. |

Use unit tests for schemas, capability discovery and request-state transitions;
real-Postgres integration tests for authorization, idempotency and budget
reservations; and CMS E2E tests for the chat/plugin media paths. Use deterministic
fixtures routinely and a separately budgeted real-provider acceptance run for
reference fidelity. Pictbook's book revision, job, PDF and KDP acceptance suites
belong in that repository. No dependency is introduced by this design PR.
