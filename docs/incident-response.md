# Caelo incident response runbook

Operator playbook for triaging + recovering from production incidents. Keep this short — when something breaks, you don't want to read prose, you want grep-able commands.

## Triage decision tree

1. **Admin returns 500 / unreachable** → §A.
2. **Deploy stuck / partial** → §B.
3. **AI calls failing or budget hit** → §C.
4. **Plugin sandbox crashed the host** → §D.
5. **Edge router serving wrong variant / 404** → §E.
6. **Database connection errors** → §F.
7. **Secret leak (committed key, exposed token)** → §G.

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
- `provider auth 401` → check `/security/ai/providers`; rotate the affected key.
- `plugin host bootstrap failed` → §D.
- `NotFound: page <slug>` after deploy → ran on stale cache; force-clear via `cms-provision regenerate-caddy` (self-hosted) or invalidate CDN paths (cloud).

## §B — Deploy stuck / partial

```sql
SELECT id, env, status, started_at, finished_at, error_message
FROM deploy_runs ORDER BY started_at DESC LIMIT 5;
```

If `status='failed'`: read `error_message`, fix root cause, then `deploy.trigger` again (admin UI or `bunx cms-provision deploy`).

If `status='running'` and `started_at < now() - interval '15 minutes'`: the static-gen subprocess died. Check stderr of the orchestrator. Manual recovery:

```sql
UPDATE deploy_runs SET status='failed', error_message='manual reset',
  finished_at=now() WHERE id='<stuck-id>';
```

Then trigger a fresh deploy.

## §C — AI calls failing or budget hit

`/security/costs` shows live status per (scope × operation_type). If a row is **blocked**:
- Bump cap at `/security/ai/budgets`, OR
- Wait until midnight UTC for `day-*` scopes, OR
- Disable the offending plugin at `/security/plugins/<slug>` if a single plugin is the source.

If text + image are both healthy but specific calls fail → check `/security/ai/providers` → primary provider's API key expired or its `model` was deprecated. Fix + re-test via the editor chat.

## §D — Plugin sandbox crashed the host

```sql
SELECT slug, tier, status, validation_errors
FROM plugins WHERE status IN ('failed', 'disabled') ORDER BY updated_at DESC;
```

Disable the offending plugin via UI or:
```sql
UPDATE plugins SET status='disabled' WHERE slug='<slug>';
```

Restart the admin (the plugin host re-bootstraps). Tier 2 plugins should never crash the host (Deno sandbox); if one did, file a security issue + revoke the plugin's actor.

## §E — Edge router serving wrong variant / 404

1. Confirm the routing manifest is fresh:

   ```bash
   # AWS
   aws s3 cp s3://caelo-prod-static/ab-routing.json - | jq .

   # GCP
   gcloud storage cat gs://<project>-caelo-prod-static/ab-routing.json | jq .

   # Self-hosted
   cat output/production/current/ab-routing.json | jq .
   ```

2. Variants the manifest references must exist as files (`output/.../_variants/<exp-slug>__<label>/<page-slug>/index.html`). If missing → static-gen didn't run after the last experiment activation. Re-run.

3. If GCP edge-router has cached an old manifest, restart the Cloud Run service (manifest cache TTL is 30s but redeploys clear it).

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
   - **Anthropic / OpenAI / Gemini key** — rotate in provider dashboard, set new value at `/security/ai/providers` (Owner only). Old key stops working within seconds at the provider.
   - **OAuth client secret** — rotate at provider (Google / GitHub), update `/security/auth`, hard-fail any in-flight OAuth flows (acceptable; visitors retry).
   - **Postgres password** — `ALTER ROLE caelo_admin WITH PASSWORD '<new>'` then update `ADMIN_DATABASE_URL` env (self-hosted: `.caelo/config.json` + restart; cloud: `pulumi config set --secret … && pulumi up`).
   - **`CAELO_INTERNAL_SECRET`** — generate new 48-byte hex, update env across admin + all internal callers (`pulumi config set` for cloud; restart for self-hosted). Any in-flight internal-API tokens become invalid (5-min replay window auto-expires anyway).
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
