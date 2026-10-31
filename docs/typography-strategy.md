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
embedding uses. Migration `0223_font_assets.sql` enables and forces RLS. There
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
reported; it blocks deployment. The build copies only the delivery files of
referenced faces and their license texts, not the font registry. Restoring an
earlier exported DTCG theme document through `themes.import` restores its
original references.

Legacy family-string themes continue using the existing Google resolver until
explicitly pinned. Variable faces expose their axis ranges; the web resolver
supports weights within `wght`. The service does not produce static
variable-font instances. Consumers state supported formats and use the chosen
face's default instance unless they implement variation selection.

### Web delivery: WOFF2 unicode-range slices

The registry keeps the complete original (an acquired Google family is a full
TTF, ~0.9 MB for Inter's variable face); visitors never download it. At build
time (and for the editor preview) `deriveWebDelivery` in
`packages/font-service/src/delivery.ts` cuts each pinned face into the script
slices Google Fonts uses (`latin`, `latin-ext`, `cyrillic`, `cyrillic-ext`,
`greek`, `greek-ext`, `vietnamese`) plus one `other` slice for any remaining
code points, encodes each as WOFF2 and emits one `@font-face` per slice with its
`unicode-range`. Browsers download only the slices a page's text needs.

- Only slices the face actually covers are emitted; together they contain every
  character of the original, so nothing is lost by slicing.
- Variation axes are instanced to the face's axis policy (next section): by
  default `wght` is limited to the weights the site uses and every other axis
  is fixed at the font's default. The `@font-face` `font-weight` descriptor
  always matches the delivered range. All OpenType layout features are kept,
  so `font-feature-settings` (`ss01`, `cv11`, `tnum`, ...) keeps working.
  Hinting is kept as well: Google strips it only for non-Windows browsers, and
  static files cannot vary by browser.
- Slices depend on the script, never on site text: editing content or adding a
  translation does not change any font file.
- WOFF and WOFF2 uploads are decoded once and encoded once (no compression on
  top of compression).
- A face whose OS/2 `fsType` forbids subsetting ships as one whole-face WOFF2
  without `unicode-range` (a WOFF2 upload is shipped unchanged).
- Derived files are cached under `pinned/<source sha256>.<axis spec
  hash>.<slice>.<toolchain tag>.woff2`; the spec hash covers the effective axis
  policy, and the tag hashes the installed versions of subset-font, harfbuzzjs,
  fontverter and wawoff2 plus the slice table and the derivation algorithm, so
  a policy change or a dependency upgrade produces new files instead of
  reusing old output. The names are content-addressed, so CDNs cache them as
  immutable.
- Each slice is re-read and checked (WOFF2 signature, every intended code point
  mapped, exactly the axes the policy promises: fixed axes gone, limited axes at
  their range). Any failure fails the deploy with
  `theme-font-unresolvable:pinned:<role>:FontDeliveryFailed:<slice>:<reason>`;
  the original file is never shipped as a substitute.
- One slice per pinned face is preloaded: the one for the likely script of the
  site language (`site_defaults.site_language`, e.g. `de` → `latin`,
  `ru` → `cyrillic`, `el` → `greek`). Other scripts and unsplit faces get no
  preload, because a preloaded slice the page never uses is wasted bandwidth.

Operators do not need to convert fonts to WOFF2 before uploading.

### Variable axes: what visitors download

A variable font carries its whole design space (Inter: weight 100-900 and
optical size 14-32). Most sites use a fraction of it, and every axis costs
bytes in every slice. Inter's latin slice is 103 KB with every axis and about
52 KB under the default policy. Each axis of a pinned face is delivered in one
of three ways:

| Setting | Meaning |
|---|---|
| `"full"` | keep the font's whole range |
| `{ "min": 400, "max": 700 }` | keep only this range |
| `14` | fix the axis at one value; it disappears from the delivered file |

**Default (no override).** `wght` keeps the range from the lowest to the
highest weight the site can render; every other axis is fixed at the font's
default value, as Google Fonts does. Weight usage is derived site-wide and
conservatively from the theme's typography weights, every stored module
(HTML, CSS, JS, field defaults), template, layout, content value and Tier-2
plugin source, on every chat branch, so preview and deploy agree and an
unpublished change can only widen the range. 400 (the initial value) and 700
(browser bold for headings) are always included, and the set is closed under
`bolder` (`<strong>` in rich text, 400 → 700 → 900) and, if the site uses it,
`lighter`. `var(--x)` is resolved against every declaration of `--x`. If a
weight cannot be determined with certainty (`calc()`, a property set from a
script, a template placeholder, a system font keyword), `wght` stays full:
keeping every weight is the safe outcome. An axis named in
`font-variation-settings` anywhere on the site stays full. A face whose
license forbids subsetting is always delivered whole.

**Cost per render (#803).** That scan reads the whole site, so
`loadSiteFontUsage` caches its result in-process together with the Postgres
change-journal mark it read at. Every write to the scanned tables leaves rows in
the entity change journal (#1267, migration 0430, insert-only so writers never
wait on each other); a cached result is served only when the reader's snapshot
provably sees the same rows, otherwise the scan runs again. Preview and build share the
cache, so they keep deriving the same weights. `resolveThemeFonts` reads each
bound face once per resolve however many roles bind it, and `fontReader` reads
a revision's bytes in one query and keeps them in a bounded in-process cache
(revisions are immutable); a cached read still checks the revision under the
caller's transaction.

The one visible effect of the default is the optical size: browsers normally
pick it from the font size, so large headings get the display design. With
`opsz` fixed, headings use the text design. Operators who want optical sizes
keep them per font file with `{ "opsz": "full" }`.

**Override.** Stored as `$extensions["caelo.fontAxes"]` next to the
`caelo.font` binding on every typography role bound to the font file; the
policy belongs to the file, so all its roles share it. Axes the override does
not name follow the default. An axis the face does not have, a value outside
the face's range, or a weight range that excludes a weight a bound role uses is
rejected with the face's real ranges, never silently clamped. Changing a role's
font family drops its override with its binding.

Ask the AI ("make the fonts load faster", "keep the optical sizes on the
headings") or use **Design → Themes → Typography → Font delivery**. The AI
reads the effective policy, the derived weight usage and the slice sizes with
`get_theme(as: "font-delivery")` and sets or resets an override with
`set_theme_tokens({ fontAxes: { heading: { opsz: "full" } } })` (`null`
resets a role's font file to the default).

## AI and plugin API

Core tools are `find_fonts`, `list_font_variants`, `acquire_font`, `inspect_font`
and `preview_typography`; `get_theme(as: "font-delivery")` and
`set_theme_tokens.fontAxes` cover delivery (see above). The latter validates the requested text/use and links
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
