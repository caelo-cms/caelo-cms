# Phase 13 — Static + delta pattern, auto-redeploy, gateway hardening

**Status:** stub — detail to be filled when this phase is picked up.
**Dependencies:** P6, P12.
**Unblocks:** P14 (hardened stack shipped by provisioning).

## Goal (from master plan)
Static generator bakes approved plugin data into HTML at deploy and injects a `since` timestamp into each Web Component so it only fetches deltas after deploy. API Gateway (Bun-based reverse proxy or Caddy module) with rate limiting per endpoint, CAPTCHA/PoW on public writes, honeypot fields, and strict `public_role` INSERT-only enforcement. Auto-redeploy webhook with 10–15s debounce + admin toggle. **A/B traffic split at the edge:** when the P6 generator emits multiple variants for a module (per a P4 sibling-variant snapshot), the gateway/edge layer selects a variant per visitor using a stable hash (cookie / visitor id), writes the assignment, and emits a log line consumed by the P12A analytics plugin. Split ratios read from the experiment record in `cms_admin`; refreshed per deploy. Deliverable: approve a comment → debounced build → fresh HTML deployed; new comment post-deploy appears via delta fetch; live A/B experiment produces stable per-visitor assignments with per-variant impressions visible in the Experiments dashboard.

## End-to-end verification
Approve comment → debounced rebuild fires once → new static HTML served; comment posted after deploy appears via delta fetch; **live A/B experiment on the homepage hero produces stable per-visitor variant assignments; per-variant impression counts flow into the analytics plugin and surface in the Experiments dashboard**.

## To be detailed before execution
- Static generator extension: call each plugin's `staticRender` per page+locale; inject result + `<web-component since="...">` wrapper.
- Delta endpoint per plugin: `list(page_id, locale, since)` — already defined in P11 SDK.
- Auto-redeploy debounce: single-flight timer, 10–15s; admin toggle in security control panel.
- API Gateway choice: Bun proxy (tighter SDK integration) vs Caddy module (leverages existing binary). Decide when starting this phase.
- Rate limiting: per-IP + per-endpoint; sliding window.
- CAPTCHA/PoW: hCaptcha for cloud, PoW (hashcash-style) for self-hosted zero-config.
- Honeypot: invisible form field; submission with it populated = silent drop.
- `public_role` enforcement: Postgres-level GRANT limited to INSERT on declared plugin tables — verified by adversarial integration test.
- **A/B edge split (self-hosted / Caddy gateway):**
  - Reads the `routing-manifest.json` emitted by the P6 generator per deploy.
  - On request: hash(visitor_cookie || IP-salt) mod 100 → variant bucket per experiment; sticky across pageviews via a first-party assignment cookie (GDPR-compliant, no third-party tracking).
  - Serves the selected variant; records `experiment_id`, `variant_label`, `visitor_bucket`, `timestamp` in the Caddy access log format the analytics plugin consumes.
  - Gracefully degrades to the default variant if the manifest is missing or malformed.
- Adversarial test: variant selection is deterministic per visitor across pageviews; tampering with the cookie does not expand the visitor's influence on results (bucket is recomputed + validated).
