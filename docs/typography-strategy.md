# Typography as a shared design capability

Status: proposal for the font-service work; the role-based AI guidance in this PR
is implemented. This does not introduce a font registry, plugin grant or PDF API.

## Problem and current implementation

An operator asking for an expressive title needs a deliberate typographic
composition. Changing the family name, increasing a body font or coloring each
letter does not by itself produce that outcome. The Pictbook cover exercise
also exposed the cost of each plugin bundling a separate font system.

Caelo already has useful foundations:

- `packages/shared/src/themes.ts` validates typography composites; theme roles
  in `$description` describe intended use. `theme-render.ts` emits family, size,
  weight, leading and tracking variables. A `display` role can already be added.
- `apps/admin/src/lib/components/theme/FontFamilyPicker.svelte` offers names from
  the authenticated `/design/themes/api/fonts` catalog proxy. Its dropdown sets
  `font-family`, but does not itself load those families; an uninstalled face
  can therefore look like the browser fallback rather than a genuine specimen.
- `apps/static-generator/src/fonts-resolver.ts` is shared by page preview and
  deployment. It downloads Google font faces and serves local files, reports
  unresolved families, and keeps preview/deploy resolution aligned.
- The resolver currently models family and weight requests. Its cache identity
  does not model a complete font asset revision, requested style, variable axes,
  license evidence or export capability.
- The plugin SDK has no shared font catalog/resolution interface. A plugin cannot
  assume a website's WOFF2 resource is suitable for its PDF renderer.

Keep these foundations. Book layouts, title lettering, PDF composition and print
profiles remain in Pictbook, never in core CMS tables or services.

## Design behavior implemented in this PR

The shared AI guidance now distinguishes sustained-reading text, structural
headings and expressive display titles. The AI plans hierarchy, line breaks,
weight and spacing, records role constraints, and chooses a restrained pairing
appropriate to the brief. It preserves an existing brand unless a redesign is
requested. Creation, cold-start setup, theme edits and the persistent theme
context receive the same guidance.

The AI must inspect actual loaded fonts, mobile wrapping and the author's own
characters. Generated lettering remains a separately approved image treatment:
it is not editable text, a font file, or a reusable site font. Keep accessible
semantic text without a second visibly duplicated title.

## Proposed shared font service

One service should supply the theme picker, AI discovery tools, preview/deploy
and approved external plugins. Do not add independent catalogs to each surface.

A family listing should include source, classification, supported weights and
styles, variable axes, language coverage, and known usage notes. Distinguish a
catalog suggestion, a locally available face and a validated export asset.
Expose catalog source/status when upstream lookup is unavailable; a small
curated list is useful but must not masquerade as the full catalog.

Persist an immutable face revision with:

- stable family/face identity and SHA-256 of the actual font bytes;
- weight, style, supported axes and glyph coverage;
- source/provenance and the accompanying license/attribution evidence;
- available formats and validated uses (`web`, `document-embedding`), including
  an explicit unknown/not-validated state;
- tenant ownership/visibility, storage identity and references from saved designs.

Theme and plugin documents can pin these revisions. Never change an old print
export or published design because an upstream font file changed. Retain assets
while a saved revision references them. Existing family-string theme tokens must
remain readable; explicit resolution can add pins without rewriting old designs.

Do not promise PDF embedding based only on a catalog name, WOFF2 availability or
an OS font. Validate the exact file, renderer format support, needed glyphs and
recorded usage evidence. Missing glyphs or unsupported embedding should return
an actionable error, not synthetic bold/italic or an unannounced substitute.

### Proposed tools and SDK contract (not yet shipped)

- `find_fonts`: discover candidates by role, language, category and availability;
  return enough context for the AI to choose without asking implementation questions.
- `inspect_font`: report the exact face/version, coverage, variants, source and
  validated uses. Do not present aesthetic suitability as a hard guarantee.
- `preview_typography`: compare actual loaded faces using the author's text in
  role-based specimens and mobile/desktop layouts. Keep private sample text local;
  downloading a font does not require sending the text to a provider.
- `ctx.fonts.resolve`: return a pinned descriptor and a bounded, authorized read
  handle suitable for the requested use. No raw storage paths or arbitrary remote
  URLs. Any conversion must be an explicit deterministic derivative, retain the
  original, and record its source hash. Do not expose an unbounded parser to a plugin.

These names are discussion proposals, not APIs a plugin may call today. Separate
local metadata reads from font acquisition/import. Reuse the theme read/write
permissions for theme operations; font imports need explicit actor authority.
Plugin access should follow the approved external-plugin capability model: a
reviewed grant at installation, the same host-enforced API for internal and
external plugins, tenant scoping and immediate revocation. Routine authorized
font reads should not prompt again on every use.

Uploaded font files need the same bounded validation and provenance treatment
as downloaded files. Preview private uploads through authenticated routes; a
published web design may publish only the explicitly selected font assets.
Bundled plugin fonts remain a supported offline option with their notices.

## Rollout and acceptance

1. **Role guidance (this PR):** reuse current token and resolver behavior. No new
   permissions, downloads, dependencies or database schema.
2. **Honest specimens and discovery:** consolidate the catalog, show its status,
   load real faces in the picker, and expose discovery to the AI. Acceptance:
   `document.fonts.load/check` with the requested text, actual face network
   evidence, and a visible error instead of a mislabeled fallback sample.
3. **Versioned assets:** add the registry/read operations and import validation.
   Acceptance: stable hashes, exact weight/style, accent/non-Latin fixtures,
   unavailable provider, offline cache, malformed/oversized files, tenant isolation,
   and revision-aware retention tests. Do not silently map unsupported weights.
4. **Plugin bridge:** introduce the grant and SDK descriptors only after the
   asset contract is reviewed. Acceptance: same API for internal/external plugins,
   denied reads without a grant, revocation, no arbitrary URL/path fetch, no private
   font leakage into a public preview, and restart-safe pinned resolution.
5. **Pictbook integration:** choose a real display/body pairing from that service,
   embed the selected validated face and retain its asset identity in each book
   revision/export. Verify selectable Unicode text, embedding, layout/overflow,
   glyph coverage and raster comparison in PDF. PDF-specific checks stay in Pictbook.

For the current Mila cover, the requested custom lettering is image artwork;
it does not replace this font work. The author line and summary remain real text.

## Review decisions

Decide the registry owner/package without introducing the existing
admin-core/static-generator dependency cycle; whether theme face pins live in
DTCG extensions or a companion structured binding; and the minimum upload/export
formats for the first release. Avoid committing to automatic font conversion or
universal PDF support before a renderer-backed compatibility test exists.
