# Phase 7 — Media library

**Status:** stub — detail to be filled when this phase is picked up.
**Dependencies:** P2, P3, P6.
**Unblocks:** P8 (OG images), P12 (plugin assets).

## Goal (from master plan)
Object-storage abstraction (local volume adapter for self-hosted). Upload endpoint with MIME/size validation. Auto image optimization on upload (sharp → resize variants + WebP). Media browser in admin. AI references media by URL via Query API only (no direct storage access). **Usage tracking + optional CDN copy at deploy time** (requirements §10): frequently-used assets are copied to the static hosting CDN during deploy for faster delivery; toggle in admin settings. Deliverable: upload an image in admin, AI places it into a module, deploy renders the optimized asset and (when enabled) serves it from the CDN.

## End-to-end verification
Upload image → optimized WebP variants present → AI references URL → appears in deploy; with CDN-copy toggle on, frequently-used assets are served from the CDN path and verified via response header.

## To be detailed before execution
- Storage adapter interface: `put(key, stream) → url`, `get(key)`, `delete(key)`, `list(prefix)`.
- Local volume adapter for self-hosted; S3/GCS/Azure adapters come in P15.
- Upload endpoint: MIME sniff (not just header), max size, auth required.
- sharp version (verify current) + variant ruleset (e.g. 320w, 640w, 1280w + original; WebP + original format).
- `media_assets` table: id, key, mime, size, variants JSON, uploaded_by, uploaded_at, **usage_count, last_referenced_at**.
- Reference tracking: increment `usage_count` whenever a module or SEO field references the asset (hook in the Query API write path).
- **CDN-copy strategy:** deploy-time step selects assets above a configurable usage threshold and pushes them to the provider's CDN origin; admin toggle `cdn_copy_enabled` + threshold.
- AI tool: `set_module_image(module_id, field, media_id)` — never a URL AI constructed itself.
