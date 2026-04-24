# Phase 10 — AI translation (Mode 1 + Mode 2) + dashboard

**Status:** stub — detail to be filled when this phase is picked up.
**Dependencies:** P5, P9.

## Goal (from master plan)
Block-level structured diff generator. Glossary + style guide storage. Translation dashboard: per-page, per-locale status. Mode 1 = new locale variant; Mode 2 = update with full source + existing translation + structured diff. All translations go through standard preview → user confirms → snapshot. Cannot change module structure between locales. **UX simplification (UX-5):** *One primary action per dashboard row* — a single "Bring up to date" button that dispatches to Mode 1 or Mode 2 automatically based on `translation_status`. A single top-level "Auto-translate everything stale" covers site-wide bulk. Granular controls (translate-only vs update-only, per-locale bulk, re-run with different provider) live in an "Advanced actions" drawer. Editors never see a five-button row.

## End-to-end verification
Edit source page → `de` auto-flagged `needs_update`; **single "Bring up to date" button on the dashboard row dispatches to Mode 2**; **one top-level "Auto-translate stale" works**; translation preview → confirm → snapshot. Granular controls reachable from Advanced drawer.

## To be detailed before execution
- Block-level diff: compare content fields section-by-section; emit typed operations.
- `glossary` and `style_guide` tables, site-scoped and locale-scoped.
- Translation dashboard queries: per-page, per-locale status matrix with counts of changed sections.
- **Primary action resolver:** given a row's `translation_status`, returns `Mode 1` for `not_started` / `Mode 2` for `needs_update` / disabled for `up_to_date` / disabled for `source`. Single button reads this.
- **Bulk top-level action:** "Auto-translate everything stale" queues Mode 2 for every `needs_update` + Mode 1 for every `not_started`, respecting cost caps.
- **Advanced actions drawer:** force-retranslate, per-locale bulk, switch provider for this batch, reset translation state.
- AI tool definitions / skills: `translate_new(page_id, target_locale)` and `translate_update(page_id, target_locale)` — in P10A these are reified as `translation-mode-1` and `translation-mode-2` skills. Both return preview; never publish directly.
- Structural lock: translations share module references with source; AI can only edit content fields inside those module references, not swap modules.
- Bulk actions: queue + progress tracking; respects cost caps from P5/P16.
