# Caelo telemetry policy

**Status: OFF by default. No outbound calls without explicit opt-in.**

Caelo phones home for nothing on a fresh install. Operators who want to opt in to telemetry can do so per-category at `/security/telemetry`. The settings live in `cms_admin.telemetry_settings` (single row, `install_ping_enabled` / `error_reporting_enabled` start as `false`).

This doc is part of the OSS-launch checklist; reviewers explicitly check the "off by default" claim against the code (the migration 0048 seed asserts both columns default false; the Owner UI is the only path to enable).

## Categories

### Install ping (opt-in)

When enabled, Caelo sends one POST per install per week to `https://telemetry.caelo-cms.com/v1/install` with:

```json
{
  "caelo_version": "0.5.0",
  "provider": "aws",
  "anonymized_install_id": "<uuid minted at first opt-in; never sent before>"
}
```

Used for "how widely is Caelo deployed?" stats. **No PII, no AI usage data, no error reports, no DB rows.** The `anonymized_install_id` is a fresh UUID minted at opt-in time; revoking opt-in resets it (next opt-in mints a new one).

### Error reporting (opt-in)

When enabled, structured-log entries with `level: "error"` are sent to a public-facing GitHub Issues bot at `github.com/caelo-cms/telemetry-errors`. The payload is:

```json
{
  "ts": "2026-05-03T...",
  "caelo_version": "0.5.0",
  "service": "admin",
  "msg_sha256": "<sha256 of the redacted msg>",
  "category": "plugin_host_bootstrap_failed"
}
```

**Never sent**:
- The actual error message (only its SHA-256 hash).
- Stack traces.
- HTTP request payloads / headers / cookies.
- SQL queries.
- Chat content / AI prompts / plugin data / visitor PII / any DB row.
- The `request_id` (would let an attacker correlate across submissions).

The category enum is the only human-readable field. Categories are pre-defined in `apps/admin/src/lib/server/telemetry-categories.ts`; the operator can review the mapping at `docs/TELEMETRY.md#error-categories` before opting in.

### What is NEVER collected, regardless of opt-in

- Page content, module HTML, template HTML, plugin data.
- AI prompts (system or user), AI responses, AI tool args.
- Visitor PII (emails, IPs, session tokens, cookies).
- Auth tokens, secrets, API keys.
- Database rows from any table.
- Source code or config files.

These are off-limits even with both telemetry toggles enabled. Code paths that touch any of these are forbidden from calling the telemetry sink.

## Owner UI

`/security/telemetry` shows:
- Two toggles (install ping / error reporting), both `false` on fresh install.
- Live counter: `events_sent_count` + `last_sent_at` from `telemetry_settings`.
- A **"Test send"** button that prints the exact payload that WOULD be sent locally without making an outbound HTTP call. Operators can verify the redaction + hash before enabling.
- A **"Revoke + reset install id"** button that disables both categories + clears `install_id`.

## Verification before P17 release

Before P17 ships, the release engineer MUST verify with a packet capture on a fresh install that:
1. No outbound HTTP traffic occurs without explicit opt-in.
2. After enabling install ping, the payload matches this spec verbatim (no extra fields).
3. After enabling error reporting, no field other than `{ts, caelo_version, service, msg_sha256, category}` is present.

Failure modes (any default-on telemetry, any leak of PII / message body) block the release.

## Error categories

(Categories grow as new error types stabilize. Only categories listed here are valid for telemetry; an unknown category is dropped at the sink.)

| Category | Trigger |
|---|---|
| `plugin_host_bootstrap_failed` | Tier-1 plugin loader threw at admin startup |
| `plugin_sandbox_panic` | Tier-2 sandbox process exited abnormally |
| `provider_auth_401` | AI provider rejected API key |
| `provider_quota_exceeded` | AI provider returned quota / rate-limit hard error |
| `db_connection_lost` | Postgres connection dropped + reconnect failed > 3× |
| `static_gen_panic` | Static-generator subprocess crashed |
| `edge_router_manifest_load_failed` | Edge router couldn't fetch the routing manifest |
| `migration_drift_detected` | Migrations applied but RLS-drift check failed |

Adding a new category means: append a row here, add the constant in `apps/admin/src/lib/server/telemetry-categories.ts`, ship in a release. No category = no telemetry.
