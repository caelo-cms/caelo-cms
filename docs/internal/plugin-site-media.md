# Plugin access to site media (`site_media_read`)

Issue #530. A plugin granted `site_media_read` (Owner receipt per reviewed
artifact, like every other grant) can read images from the site's media
library:

- `ctx.siteMedia.find({ query?, visibility?, limit? })` — images by alt text or
  filename; `visibility` defaults to `library`, `reference` / `all` include the
  reference images of #531.
- `ctx.siteMedia.inspect({ ids })` — metadata by id or slug (dimensions, MIME,
  sha256, visibility, `derivedFromId`).
- `ctx.siteMedia.readChunk({ id, sha256, offset })` — 262 144-byte chunks of the
  original, verified against `sha256`.

Images (PNG, JPEG, WebP, GIF, AVIF) only; this is for references and
inspection, not a file export.

`ctx.images.generate` / `edit` accept `{ id, sha256, source: "site-media" }` as a
reference, source or mask. The ledger records the reference with kind
`site-media`.

## Checks

Every call:

1. rechecks that the human the plugin acts for may still author content
   (`operatorCanAuthor`), and
2. runs a `plugin_site_media.*` operation as the plugin, which checks the grant
   for exactly the running artifact in its own transaction
   (`privateGrantRefusal`) — a revocation applies on the next call.

The operations return where the bytes live; the broker reads them through the
host's `siteMediaBytes` hook (`apps/admin/src/hooks.server.ts`), so the plugin
never sees a storage key. Shipped and installed plugins get the handle on the
same terms: an authoring invocation, never on a render or visitor call.
