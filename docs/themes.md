# Themes

How Caelo's theming works after issue #112 (v0.12.x): **the AI composes the
theme itself**. There is no preset menu — the four predefined palettes that
shipped through v0.11 (`shadcn-default`, `minimal`, `warm`, `playful`) were
removed because a fixed menu leaked an implementation detail into the AI's
decision surface (CLAUDE.md §1A) and let a grayscale mint count as "branding
the site".

## The token document

A theme's `tokens` column holds one DTCG-aligned document (schema:
`packages/shared/src/themes.ts`, `themeDocument`). Categories: `color`,
`typography`, `spacing`, `radius`, `shadow`, `motion`, `breakpoint` — each
leaf is `{$type, $value}`. The renderer emits one CSS variable per token
(`--color-primary`, `--spacing-md`, …); module CSS must reference those
variables so token edits cascade.

Creating a theme requires the **caller to author the complete document**:

- **AI path (canonical):** `propose_create_theme({slug, displayName,
  description, tokens, overrides?})` — the AI composes `tokens` from brand
  context (site identity, the operator's wording, the industry). The
  shared guidance fragments the AI sees live in
  `packages/admin-core/src/ai/theme-guidance.ts`.
- **Owner panel path:** the `/design/themes` Create dialog clones the
  *active* theme's document as the base (duplicate-then-tweak); fully new
  palettes go through chat.
- `description` is **required** — it records why the palette fits the brand
  (see the cold-start gate below).
- `overrides` accepts loose names (`primaryColor`, `fontHeading`, …);
  `overrides.primaryColor` derives a 50–900 OKLCh lightness ramp
  server-side (stops annotated `_derived: true`; explicit stops win).
- The document is validated at the Query API boundary (Zod) and re-validated
  at execute time; documents over 256 KB are rejected
  (`packages/admin-core/src/theme-document-input.ts`).

## The cold-start gate

A fresh install ships a deliberately **grayscale seed theme**
(`origin='seed'`, seeded by migration 0099). The gate
(`packages/admin-core/src/ai/tools/_cold-start-gate.ts`) blocks AI
module-creation tools until both hold:

1. site identity is captured (`siteName` or `sitePurpose`), and
2. the active theme is **brand-derived**: `origin != 'seed'` **and** a
   non-empty `description`.

Origin alone is not enough — that was the #112 regression: flipping origin
was satisfiable by minting a neutral palette and stopping. The description
requirement makes "someone recorded why this palette fits" the explicit,
stored signal (no color heuristics — CLAUDE.md §2). A theme that is evolved
but undescribed (e.g. via `import_theme`) gets a `set_theme_meta`-only
instruction, not a recompose.

## Propose / execute (CLAUDE.md §11.A)

Theme create / activate / delete are gated: the AI (or the panel) proposes,
a human Owner approves at `/security/themes/pending`. See
[propose-execute-pattern.md](./propose-execute-pattern.md) for the shared
mechanics. Theme-specific notes:

- The create proposal's preview carries `tokenCount` + `tokensSummary` so
  the Owner reads what they're approving at a glance.
- Approving an **activate** flips the DB row only; the live site serves the
  previous theme's CSS until a deploy is separately approved
  (`propose_deploy_promote`).
- Routine edits to the *active* theme (`set_theme_tokens`,
  `set_theme_meta`, `set_theme_asset`) are not gated — they're one-tool-call
  revertible.

## Theme assets

Module HTML may use the reserved placeholders `{{theme_logo_url}}`,
`{{theme_logo_dark_url}}`, `{{theme_favicon_url}}`,
`{{theme_social_share_url}}`; the template engine resolves them from the
active theme's bound assets at render time. Unbound slots stay loud-raw
(the `{{…}}` survives in output and `theme-asset-unbound:<slot>` lands in
`missingSlots`) per the no-fallbacks rule.

## Verification

- Unit: `packages/admin-core/src/ai/__tests__/cold-start-gate.test.ts`
  (gate state matrix), `propose-create-theme-tool.test.ts` (no-preset
  boundary pins).
- Integration: `packages/admin-core/src/__tests__/themes-pending.integration.test.ts`
  (propose/execute round-trip, ramp, dedup, real-DB gate clearing).
- E2E: `apps/admin/e2e/design-themes-create.browser.ts` (Owner dialog);
  the live-AI on-brand assertion lives in
  `apps/admin/e2e-livedit/scenario-homepage.browser.ts`
  (see [internal/e2e-livedit.md](./internal/e2e-livedit.md)).
