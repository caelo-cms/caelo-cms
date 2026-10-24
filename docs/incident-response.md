# Caelo incident response runbook

Operator playbook for triaging + recovering from production incidents. Keep this short — when something breaks, you don't want to read prose, you want grep-able commands.

## Triage decision tree

1. **Admin returns 500 / unreachable** → §A.
2. **Deploy stuck / partial** → §B.
3. **AI calls failing or budget hit** → §C.
4. **Plugin sandbox crashed the host** → §D.
5. **Database connection errors** → §F.
6. **Secret leak (committed key, exposed token)** → §G.

If unsure, start with §A: tail the admin's structured logs and follow the `request_id` of the most-recent failure.

## §A — Admin 500 / unreachable

```bash
# Self-hosted
journalctl -u caelo-admin --since "5 minutes ago" | jq 'select(.level=="error")'

# AWS
aws logs filter-log-events --log-group-name /ecs/caelo-admin \
  --filter-pattern '{ $.level = "error" }' --start-time $(($(date +%s) - 300))000

# GCP
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="caelo-admin-prod" AND severity>=ERROR' --limit 50 --format json

# Azure
az monitor log-analytics query -w <workspace-id> --analytics-query \
  "ContainerAppConsoleLogs_CL | where ContainerAppName_s == 'caelo-admin' and Log_s contains '\"level\":\"error\"' | take 50"
```

Pull the `request_id` from the first error → search across services:

```bash
# Self-hosted
journalctl -u caelo-admin -u caelo-gateway -u caelo-orchestrator -u caelo-runner | jq 'select(.ctx.requestId == "<id>")'
```

Common causes:
- `psql connection refused` → §F.
- `provider auth 401` → check `/settings/ai/providers`; rotate the affected key.
- `plugin host bootstrap failed` → §D.
- `NotFound: page <slug>` after deploy → ran on stale cache; force-clear via `cms-provision regenerate-caddy` (self-hosted) or invalidate CDN paths (cloud).

## §B — Deploy stuck / partial

```sql
SELECT id, env, status, started_at, finished_at, error_message
FROM deploy_runs ORDER BY started_at DESC LIMIT 5;
```

If `status='failed'`: read `error_message`, fix root cause, then `deploy.trigger` again (admin UI or `bunx cms-provision deploy`).

A Stage or Publish live shows as `status='running'` while it builds (its row is committed when it starts, with `progress` updated about once a second). A run whose process died (crash, restarted instance) stays `running` until the next Stage or Publish live: that one marks it `failed` with "This build stopped without finishing …" — a run still building on another instance holds an advisory lock on its id and is left alone. Nothing a stopped run built was published; start it again. Check the admin's stderr for why it stopped.

### Stage / Publish live slow

Every Stage and Publish live records where its time went (`deploy_runs.phase_timings`, since 0346) and logs one line per run: `[deploy] stage succeeded in <ms> ms {…}`. The Stage button's whole wait, chat merges included, is logged as `[stage] staged <n> pages in <ms> ms {…}`.

```sql
SELECT id, status, page_count, file_count,
       (EXTRACT(EPOCH FROM finished_at - started_at) * 1000)::int AS took_ms,
       phase_timings
FROM deploy_runs WHERE phase_timings IS NOT NULL
ORDER BY started_at DESC LIMIT 5;
```

Top-level steps (`prepare`, `generator`, `lock-wait`, `publish`, `parity`, `select-preview`, `finish`) add up to the run. A dotted name breaks down the step it starts with: `generator.compose` / `generator.media` / `generator.write` are the build's passes, `publish.hash` / `publish.upload` the provider upload. A long `lock-wait` means another Stage or Publish live held the staging lock.

### Stage / Publish live slow

Every Stage and Publish live records where its time went (`deploy_runs.phase_timings`, since 0346) and logs one line per run: `[deploy] stage succeeded in <ms> ms {…}`. The Stage button's whole wait, chat merges included, is logged as `[stage] staged <n> pages in <ms> ms {…}`.

```sql
SELECT id, status, page_count, file_count,
       (EXTRACT(EPOCH FROM finished_at - started_at) * 1000)::int AS took_ms,
       phase_timings
FROM deploy_runs WHERE phase_timings IS NOT NULL
ORDER BY started_at DESC LIMIT 5;
```

Top-level steps (`prepare`, `generator`, `lock-wait`, `publish`, `parity`, `select-preview`, `finish`) add up to the run. A dotted name breaks down the step it starts with: `generator.compose` / `generator.media` / `generator.write` are the build's passes, `publish.hash` / `publish.upload` the provider upload. A long `lock-wait` means another Stage or Publish live held the staging lock.

## §C — AI calls failing or budget hit

`/settings/costs` shows live status per (scope × operation_type). If a row is **blocked**:
- Bump cap at `/settings/ai/budgets`, OR
- Wait until midnight UTC for `day-*` scopes, OR
- Disable the offending plugin at `/settings/plugins/<slug>` if a single plugin is the source.

If text + image are both healthy but specific calls fail → check `/settings/ai/providers` → primary provider's API key expired or its `model` was deprecated. Fix + re-test via the editor chat.

## §D — Plugin sandbox crashed the host

A plugin that fails to load is never switched off automatically: its `status`
stays what the Owner decided, and the failure is recorded instead (#1008).
`/settings/plugins` shows it as "Not loading" with the reason; the same data:

```sql
-- What each running server makes of each plugin (heartbeat within 2 min = live).
SELECT plugin_slug, instance_id, state, heartbeat_at
FROM plugin_runtime WHERE heartbeat_at > now() - interval '2 minutes' ORDER BY plugin_slug;

-- Every recorded problem: phase, whose fault (transient / plugin / core), how often.
SELECT plugin_slug, phase, error_class, occurrences, last_seen_at, message
FROM plugin_errors ORDER BY last_seen_at DESC LIMIT 20;
```

A `core` error is Caelo's (it went to the bug intake when forwarding is on).
Servers do not retry a failing plugin on their own: once the cause is fixed,
click **Reload on all servers** on `/settings/plugins` (or ask the AI —
`reload_plugin`). Every admin instance follows plugin changes within seconds
of the next request (it compares a fingerprint of the plugin rows), so a restart is
not needed for an activation, disable, uninstall or reload to take effect.
While an active plugin does not run, Publish live is refused, and a Stage
built during that time is never published — Stage again after the reload.

To stop a plugin that misbehaves, disable it via the UI or:
```sql
UPDATE plugins SET status='disabled' WHERE slug='<slug>';
```

Restart the admin (the plugin host re-bootstraps). A plugin should never crash the host (Deno sandbox); if one did, file a security issue, disable the plugin and revoke its grants.

## §F — Database connection errors

```bash
# Self-hosted
docker compose exec postgres pg_isready

# AWS RDS
aws rds describe-db-instances --db-instance-identifier caelo-prod-pg \
  --query 'DBInstances[0].DBInstanceStatus'

# GCP Cloud SQL
gcloud sql instances describe caelo-prod-pg --format='value(state)'
```

If `available` but admin still can't connect: check security-group / VPC peering / private-IP route. RDS Multi-AZ failover takes ~60s — admin reconnects automatically.

## §G — Secret leak (committed key, exposed token)

If a Caelo secret (Anthropic key, OAuth client secret, postgres password, internal-API HMAC secret, cookie/CSRF secret) is exposed:

1. **Rotate at the source FIRST.** Before any cleanup, the leaked value must be invalid:
   - **Anthropic / OpenAI / Gemini key** — rotate in provider dashboard, set new value at `/settings/ai/providers` (Owner only). Old key stops working within seconds at the provider.
   - **OAuth client secret** — rotate at provider (Google / GitHub), update `/settings/auth`, hard-fail any in-flight OAuth flows (acceptable; visitors retry).
   - **Postgres passwords** — one per database role. GCP: `bunx @caelo-cms/provisioning rotate-secret postgres-password` (admin_role; rolls the admin), `rotate-secret public-role-password` (the API gateway's only login; rolls the gateway). Each sets its role's password, stores the new value in Secret Manager and rolls the services that read it. A suspected gateway compromise: rotate `public-role-password` — the gateway has held no cms_admin credential since #635 (and no admin_role password since #613); then review what the admin read back from cms_public (docs/dev/public-admin-read-paths.md). Self-hosted: `ALTER ROLE … WITH PASSWORD '<new>'`, update `rolePasswords` in `.caelo/config.json`, re-run `cms-provision up`, restart.
   - **`CAELO_INTERNAL_SECRET`** — GCP: `bunx @caelo-cms/provisioning rotate-secret internal-secret`. Self-hosted: generate new 48-byte hex, update env across admin + all internal callers, restart. Any in-flight internal-API tokens become invalid (5-min replay window auto-expires anyway).
   - **Remote-MCP seal key (`CAELO_MCP_OAUTH_SEAL_KEY`, #806)** — GCP: `bunx @caelo-cms/provisioning rotate-secret mcp-oauth-seal-key` stores a new key and rolls the gateway with the old one pinned as `CAELO_MCP_OAUTH_SEAL_KEY_PREVIOUS`, so connected MCP clients keep working; after 30 days (the refresh-token lifetime) `rotate-secret mcp-oauth-seal-key --finish` removes it. **On a suspected leak, do not wait:** run `rotate-secret mcp-oauth-seal-key`, then at once `rotate-secret mcp-oauth-seal-key --finish --now` — every remote-MCP client signs in again, and nothing sealed under the leaked key opens any more.
   - **Google sign-in client secret (#914; IAP sign-in + remote MCP)** — create a new secret for the client in the Google console, paste the client ID and the new secret under Settings → Google sign-in, click "Check the client" (#967: Caelo verifies both redirect URIs and that the secret belongs to the client before anything is stored) and confirm the switch — every user signs in to the admin once more. The sync job hands the new secret to IAP and the gateway re-reads it within a minute; then delete the old secret in the console. Admin sign-in failing with IAP error code 9 ("Failed OAuth redirect") means the client lost redirect URI 2 (`https://iap.googleapis.com/v1/oauth/clientIds/<CLIENT_ID>:handleRedirect`): nobody can reach the admin then, so add it back on the client directly in the Google console (Google Auth Platform → Clients → the client → Authorized redirect URIs); sign-in works again within minutes. The preflight and the sync job's redirect check (#967) keep Caelo from applying such a client; a URI removed in the console later shows on Settings → Google sign-in while the admin is still reachable.
   - **`CAELO_COOKIE_SECRET` / `CAELO_CSRF_SECRET`** — rotate in env. Existing sessions invalidated; users re-login.

2. **Audit access during the leak window.**
   ```sql
   SELECT actor_id, operation, request_id, succeeded, created_at
   FROM audit_events
   WHERE created_at BETWEEN '<leak start>' AND now()
     AND succeeded = true
   ORDER BY created_at DESC LIMIT 500;

   SELECT actor_id, provider, model, request_id, cost_estimate_microcents, created_at
   FROM ai_calls
   WHERE created_at BETWEEN '<leak start>' AND now()
   ORDER BY cost_estimate_microcents DESC LIMIT 500;
   ```
   Look for: AI calls that don't match a known chat session; admin ops from unfamiliar request_ids; cost spikes coinciding with the exposure.

3. **Scrub from git history if the secret was committed.**
   ```bash
   # Verify it's actually in history (not just in a draft PR's branch).
   git log -p --all -S '<partial-secret-prefix>' | head

   # If yes: rewrite via git-filter-repo (NOT filter-branch — deprecated).
   pip install git-filter-repo  # or: brew install git-filter-repo
   git filter-repo --replace-text <(echo '<old-secret>==>***ROTATED***')
   git push --force-with-lease --all --tags
   ```
   Notify all collaborators to re-clone — rewritten history breaks existing local clones.

4. **Document in postmortem** (template below). Required sections: how the leak was detected, who knew, rotation timeline, audit-log evidence of any abuse.

5. **Add a detection rule.** If the leak was committable (e.g. plaintext in source), add a pre-commit hook (`gitleaks` MIT-licensed) so the same shape can't slip in again.

## Postmortem template

```markdown
# Incident: <one-line summary>

**Severity:** SEV{1,2,3}
**Started:** <ISO ts>
**Resolved:** <ISO ts>
**Customer impact:** <pages affected, duration, user-facing error>

## Timeline (UTC)
- HH:MM — first symptom detected
- HH:MM — operator paged
- HH:MM — root cause identified
- HH:MM — mitigation applied
- HH:MM — fully resolved

## Root cause
<narrative — what broke + why>

## What went well
<>

## What didn't
<>

## Action items
- [ ] <link to PR fixing root cause>
- [ ] <link to monitoring / alerting gap>
- [ ] <link to runbook entry to add>
```

## Adding new runbook entries

Open a PR adding a new section under `§<letter>` here. Include the trigger, the diagnostic commands per provider, and the recovery steps. Keep entries terse — when an operator is paged at 3am, prose is debt.
