# Phase 12 — Built-in plugins

**Status:** stub — detail to be filled when this phase is picked up.
**Dependencies:** P11.
**Unblocks:** P13 (plugin data baking).

## Goal (from master plan)
Ship the five plugins required by the spec, all built against the P11 SDK: Contact/generic forms; Comments (moderation, locale-aware); Newsletter signups; Ratings/likes (with static average pre-render); Authentication (email/password + OAuth2 via Arctic). `cms_public` schema materialises here. Auth plugin marked as locked from AI regeneration. **OAuth2 providers are config entries, not code changes** (§9.2). **AI summarisation & analysis of form submissions and plugin data** (§4) via a read-only `analyze_plugin_data` AI tool — invoked via the P10A `summarize-plugin-data` skill — with per-plugin field redaction. **UX simplification (UX-6):** *Built-in plugins install with one click* — AI has pre-run validation against the locked plugin source at release time, so the user sees "Install Contact Form" not a four-step validate → confirm → migrate → activate flow. The multi-step path from P11 remains for any custom / AI-authored plugin.

## End-to-end verification
Each built-in plugin round-trips: submit data via public API → admin → approve → baked into next deploy. **One-click install for built-ins (no multi-step validate/confirm/migrate/activate).** **New OAuth provider added via single config entry + secret**, without modifying auth plugin source. **AI asked "summarize last week's contact-form submissions" returns a bounded summary via the `summarize-plugin-data` skill + `analyze_plugin_data` tool, recorded in the audit log with cost.**

## To be detailed before execution
- Per-plugin schemas, operations, components, static renders — every per-page table declares `locale` (enforced by P11 Validator).
- Auth plugin: Arctic version (verify current), email/password (argon2id), session model in `cms_public`, OAuth redirect URL configuration per provider, provider credentials via secrets manager.
- **OAuth provider config registry:** `oauth_providers.ts` — each provider is `{ id, label, authorizeUrl, tokenUrl, scopes[], secretKeys[] }`; runtime iterates this list. Adding a provider = one config entry + secrets manager entries.
- Auth plugin "locked" marker: plugin registry flag prevents AI regeneration of core files; AI may write config only (including adding OAuth provider entries when the Owner has approved the corresponding secret).
- Comments moderation flow: pending/approved/rejected; reviewer role approves; locale-aware list.
- Ratings: static average computed at deploy; delta fetch updates live count.
- Public API endpoints auto-registered per plugin; all go through the API Gateway (hardening in P13).
- **`analyze_plugin_data` AI tool:** takes `plugin_id`, `time_range`, `aggregation_intent`; Query API enforces read-only scope; emitted records are field-redacted per plugin schema (e.g. never send raw emails to the AI); respects cost caps; all calls in audit log with token counts. Front-ended by the `summarize-plugin-data` skill from P10A.
- **One-click install path for built-ins:** built-in plugin manifests are signed + validated at release time; installing via the admin skips the P11 validate/sandbox-run steps (they're replayed as a post-install check, but not user-visible). Custom / AI-authored plugins continue through the full P11 multi-step path.
