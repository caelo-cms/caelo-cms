# Phase 6 — Static generator + local deploy (MVP complete)

**Status:** stub — detail to be filled when this phase is picked up.
**Dependencies:** P3 (content), P4 (snapshots), P5 (AI edits).
**Unblocks:** P7, P8, P9, P13 (static+delta extends this).

## Goal (from master plan)
Astro-based static generator that reads pages/modules from `cms_admin` via the Query API and outputs `dist/` of plain HTML/CSS/JS. Deploy target in MVP: copy to a local Nginx container in the compose stack. **Three-environment model introduced here** (§16.5): `dev`, `staging`, `production` — each a separate deploy target with its own `dist/` output. **Deployment Layer is trigger-only** (§3.1): AI can invoke the Deploy op but cannot modify the generator, the deploy script, or the target config. **UX simplification (UX-4):** *Editors see only "Draft → Live"* — the three-env model is abstracted away in the default admin. A separate "Ops" area (visible to roles holding `ops_view`) exposes dev/staging/production and the promote controls; content editors never need to know about the third environment. Single locale, no plugin data baking yet. Deliverable: **thin end-to-end MVP** — fresh install, login, AI edits a module, live preview, click Publish (editor view) → Live updates; Ops user sees the real Draft→Staging→Production flow and can promote.

## End-to-end verification
**Full MVP with simplified UX: fresh install → login → AI edit → live preview → Publish (editor view: Draft → Live); Ops user sees Draft→Staging→Production and promotes.**

## To be detailed before execution
- Astro project layout in `apps/static-generator` (verify current Astro + Bun compat).
- Data source: Query API over the network vs direct import of the query-api package (monorepo).
- Page rendering: template blocks filled with module references; module HTML/CSS/JS inlined or bundled.
- **Environment model:** `deploy_targets` table (name, env, host, path, robots_default); staging rows always set `robots_default=noindex`. Promote operation is an atomic copy, not a rebuild.
- **Editor vs Ops view:** editor UI exposes a single Publish button that maps internally to "deploy to staging + promote to production" as one action when the user lacks `ops_view`; Ops users see the two-step real flow plus the scheduled-publish queue (P12A). A `ops_view` permission is added to the P2 permission catalog.
- **A/B variant emission (reserves hooks for P4 sibling snapshots):** when a module snapshot carries `experiment_id` + `variant_label`, the generator emits each variant to a stable path alongside the main output (e.g. `module/<id>/<variant>.html`) and writes a `routing-manifest.json` the edge layer (P13/P15) reads at request time to perform the split. **No splitting happens in this phase** — just emission + manifest. Synthetic experiment fixtures feed the Playwright test.
- **Trigger-only deployment:** Deploy button calls a fixed Query API op; neither the op handler nor the generator binary is reachable via any AI tool surface.
- Deploy target: per-env `nginx` containers in compose, mounted `dist-staging/` and `dist-production/` volumes.
- Build is synchronous in MVP (no queue) — acceptable until auto-redeploy in P13.
- E2E test script: spin stack from scratch, drive the full flow via Playwright including promotion, assert final rendered HTML in both envs.
