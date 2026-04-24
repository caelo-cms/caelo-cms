# Phase 12A — Extended built-in plugins (shipped with core, not in core)

**Status:** stub — detail to be filled when this phase is picked up.
**Dependencies:** P10A (skills), P11 (SDK), P12 (first built-in plugins).

## Goal (from master plan)
Four high-value plugins built against the P11 SDK, bundled with the release but implemented as plugins — not core — to keep the core surface small. Each plugin ships a companion base skill so AI can invoke it from natural language.

## Plugins

### Scheduled publish (improvement #2)
- `scheduled_at` column on snapshots; cron-driven promoter job.
- One-click schedule in the editor's "Publish changes" pill (adds "Schedule for…" option).
- Ops view exposes the scheduled queue; editors see only their own scheduled items.
- Companion skill **`schedule-publish`**: teaches AI to parse "publish this on Friday 9am CET" → concrete `scheduled_at`.

### Component kits (improvement #4)
- Named module collections (`marketing-kit`, `blog-kit`) with enable / disable / swap semantics.
- Installs into the P3 module registry without touching schemas.
- Admin UI: kit gallery, enable toggle, impact preview (which pages use kit modules) reusing P4 severity grouping.
- Companion skill **`apply-kit`**: teaches AI to interpret "make it look like a blog" → kit pick + swap.

### Typed content model (improvement #5)
- Lightweight CMS-style types (Author, Product, Event) with references.
- Product list module reads typed content entries — single source of truth.
- Structured fields only; never raw HTML.
- Admin UI: type editor (add fields, add types), entry CRUD, reference picker in modules.
- Companion skill **`model-content`**: teaches AI to use typed references rather than duplicating copy across pages.

### Edge-log analytics (improvement #6)
- Privacy-preserving pageview / referrer / locale dashboard fed from CDN/Caddy request logs.
- No cookies, no third-party analytics, GDPR-clean by design.
- Admin dashboard: aggregates per page, per locale, per time window.
- Companion skill **`analyse-traffic`**: teaches AI to answer "how's the German blog doing?" from analytics data.
- **A/B experiment results (integrates with P4 sibling-variant snapshots):** variant impressions + engagement events (scroll depth, click-through, form submit) are aggregated per `experiment_id` + `variant_label` and surfaced in a dedicated **Experiments dashboard**. Winner promotion reuses the P4 per-module revert flow — the dashboard simply highlights the winning variant; the Owner confirms. **Additional skill `ab-analyze`** summarises experiment results in plain language and can recommend a winner (Owner still confirms via revert).

## End-to-end verification
Scheduled publish fires at target time; component kits enable / swap without schema churn; typed Product reference flows into a Product list module; analytics dashboard populates from real edge logs; **Experiments dashboard shows live A/B variant split with per-variant events; `ab-analyze` summarises the experiment in plain language**; each companion skill gives AI a one-line natural-language interface to its plugin.

## To be detailed before execution
- Per-plugin schemas, operations, components, static renders (same shape as P12).
- Cron runner: single-flight promoter job; respects the P6 Draft→Live + Ops flow.
- Kit manifest format: `{ name, description, modules[], default_page_templates[] }`; kit swap is an atomic transaction.
- Typed content migration strategy: types editable by Owner only; type removal requires reference check + user confirm.
- Analytics ingestion: tail Caddy JSON logs → aggregator → `cms_public.analytics_events` (partitioned by day) → materialised daily/weekly rollups.
- **A/B aggregator:** variant assignments (from the P13/P15 edge split) + event attribution keyed by `experiment_id` + `variant_label`; rollups power the Experiments dashboard. Event types are pluggable (at least: impression, dwell≥5s, primary-CTA click, form submit).
- **`ab-analyze` skill:** takes `{experiment_id}`, returns a plain-language summary of current results (sample size, split, lift per variant, statistical confidence note) and an optional "recommend winner" draft that surfaces the revert action — never performs it.
- Skill integration: each plugin registers its companion skill on activation; skill wiring tested by Playwright flow.
- Adversarial tests per plugin (e.g. typed content reference loops, kit swap on a kit currently mid-use).
