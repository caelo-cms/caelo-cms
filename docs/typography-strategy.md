# Caelo font service

The font service is a core Caelo capability. It works without installed plugins
and before AI provider setup. Website authoring, themes, page previews, static
builds and approved plugins use the same immutable font registry.

## Author workflow

Open **Design → Fonts** (`/design/fonts`) to search imported faces, discover
Google families, choose a file variant or upload a licensed TTF, OTF, WOFF or
WOFF2 file. Uploads include the license text and explicit declarations of web
and document embedding rights. Files are bounded to 8 MiB; collections and
malformed containers are rejected. The admin image sets `BODY_SIZE_LIMIT=12M`
to accommodate multipart overhead; custom runtimes should use the same limit.

Specimens use the actual imported file through `FontFace.load()`. The server
checks the specimen's characters against the file's cmap; an unavailable face
or missing glyph produces an error rather than a specimen in a substitute font.
Specimen text goes only to the Caelo server, never to Google. The theme editor
uses the same loaded-face component for pinned fonts.

The Google catalog reports whether it is live, cached, a curated selection
(no `GOOGLE_FONTS_API_KEY`), or temporarily unavailable. It never describes a
family suggestion as an installed font. Acquisition downloads complete TTF
faces and their actual `OFL.txt` from Google's official fonts repository; it
supports that repository's `ofl` families. Other licensed fonts can be uploaded.
No visitor browser requests Google Fonts when using pinned fonts.

## Immutable identity and storage

`packages/font-service` owns parsing, catalog acquisition and the named Query
API operations. `font_assets` in `cms_admin` stores each file, its SHA-256,
provenance, license, family/style/weight, variable axes, glyph count and allowed
embedding uses. Migration `0221_font_assets.sql` enables and forces RLS. There
is no update/delete policy or mutable latest-version pointer: importing again
creates a new ID, even for identical bytes with a different license declaration.
Database backups therefore retain the font files as well as their metadata.

Old revisions remain available for historical theme documents and plugin
revisions. There is intentionally no garbage collector or deletion API that
could break an existing reference. OS/2 embedding/subsetting restrictions are
combined with the supplied license declaration. Format compatibility and glyph
coverage are checked for the actual consumer; web availability alone does not
establish PDF compatibility.

Operations:

| Operation | Purpose |
| --- | --- |
| `fonts.import` | Validate and persist a complete immutable face; audited |
| `fonts.find` | Bounded search of installed revisions, with `hasMore` |
| `fonts.inspect` | Read exact revision metadata and license |
| `fonts.resolve` | Validate hash, web/document use, consumer formats and text |
| `fonts.read_chunk` | Read up to 256 KiB from an exact revision |

Font bytes are private. Authenticated management/preview routes enforce access;
the plugin broker separately checks installation grants and author permission.
Raw plugin Query API actors cannot read the core registry directly.

## Themes, rendering and restoration

Assign a face to body, heading, display or mono in the font library, or call:

```json
{
  "themeSlug": "site-default",
  "fontBindings": {
    "heading": { "id": "<font UUID>", "sha256": "<64 hex characters>" }
  }
}
```

`themes.update_tokens` (AI: `set_theme_tokens`) validates the binding, sets the
exact face's family/style/weight and stores the reference under the token's
`$extensions["caelo.font"]`. It preserves size, leading and tracking. Existing
theme locks, audit and snapshot emission remain in effect. Routine typography
edits preserve the reference; explicitly changing the family clears it.

A hash-derived CSS family separates different versions of the same named face.
`resolveThemeFonts` is shared by page preview, genesis previews and static
builds. Pinned references never fetch a replacement from the network. A missing
revision, hash mismatch, forbidden embedding or incompatible face/weight is
reported; it blocks deployment. The build copies only referenced font files
and their license texts, not the font registry. Restoring an earlier exported
DTCG theme document through `themes.import` restores its original references.

Legacy family-string themes continue using the existing Google resolver until
explicitly pinned. Variable faces expose their axis ranges; the web resolver
supports weights within `wght`. The service does not convert formats or produce
static variable-font instances. Consumers state supported formats and use the
chosen face's default instance unless they implement variation selection.

## AI and plugin API

Core tools are `find_fonts`, `list_font_variants`, `acquire_font`, `inspect_font`
and `preview_typography`. The latter validates the requested text/use and links
to the real specimen UI. Theme guidance distinguishes sustained-reading body
text, structural headings and expressive display text, including pairing,
line breaks, weight, spacing, contrast and existing brand constraints.

Both release-signed and runtime-installed plugins can request `font_assets`.
An external installation requires its normal exact-artifact Owner grant. The
handle is available only in author invocations, not visitor/static rendering.
Every call rechecks the active installation and the operator's `content.write`
permission; stale handles stop working after revocation. The Deno sandbox stays
in place. Read-only author previews may use the read-only handle.

```ts
const face = await ctx.fonts.resolve({
  id, sha256,
  use: "document",
  formats: ["ttf", "otf", "woff"],
  text: "Grüße aus dem Bilderbuch"
});
const chunk = await ctx.fonts.readChunk({ id, sha256, offset: 0, length: 262144 });
```

The SDK also exposes `find` and `inspect`. Generic private plugin previews may
reference `caelo-font:<uuid>:<sha256>` in font-face CSS. The host validates and
expands these references to embedded font data after authorization, keeping
large files outside sandbox RPC messages and retaining the existing restrictive
preview CSP.

Book revisions, cover design, PDF layout and print profiles stay in Pictbook.
Pictbook 0.5.0 stores selected page/cover font references in its own revisions,
validates text through `ctx.fonts`, verifies downloaded bytes and embeds the same
face in PDFs. Its bundled defaults remain available when no custom face is
selected. AI-generated lettering remains a separately requested image treatment,
not a font service feature or a substitute for editable, accessible text.

## Validation

- Real font parsing, German glyph coverage, missing characters, container limits
  and fixed-origin/bounded network reads.
- PostgreSQL import/search/resolve/chunks, immutable rows, plugin actor denial,
  theme metadata preservation, restoration and actual static-build bytes/license
  retention; unselected revisions are excluded.
- Release-plugin author access and live operator/plugin revocation.
- External Pictbook installation in Deno, shared-font preview, 24-page PDF,
  restart, visitor denial and live font-capability revocation.
- Browser import, actual FontFace loading, private file access and missing-glyph
  feedback (`apps/admin/e2e/font-service.browser.ts`); a separate manual browser
  run also exercises real Google acquisition and theme assignment.

References: [Google Fonts repository](https://github.com/google/fonts),
[Google catalog API](https://developers.google.com/fonts/docs/developer_api).
