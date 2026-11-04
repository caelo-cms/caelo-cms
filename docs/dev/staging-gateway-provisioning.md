# Staging gateway provisioning

Since #1330 / #1331 (epic #763, converge release 2, infrastructure contract 20), every install that serves a protected staging site runs a **staging gateway**: the live gateway's image with `CAELO_GATEWAY_ENVIRONMENT=staging`. It serves the staged build from staging storage behind the staging gate, on every host it answers (`*.run.app` included), and staging's own data (`cms_public_staging`). How the gateway serves is in [gateway-hardening.md](./gateway-hardening.md); this page is about what provisioning creates.

## One shape, per provider (E11)

| | Service | Staged files | Edge in front |
|---|---|---|---|
| gcp-firebase | Cloud Run `caelo-<env>-staging-gateway`, ingress all, `allUsers` invoker | new private bucket `<project>-caelo-<env>-staging` | a second Firebase Hosting site (`caelo-<env>-stg-<6 hex of the live site id>`) with one `**` rewrite to the staging gateway; the staging host is its custom domain |
| gcp | Cloud Run `caelo-<env>-staging-gateway`, internal-and-LB ingress | the existing private staging bucket | the site's load balancer: a host rule `<staging host>` → path matcher `staging` → the staging gateway's serverless NEG and backend (the gateway's Cloud Armor policy, an extra layer: its general ban covers `/api/` paths only, #1339), and a managed certificate `caelo-<env>-staging-cert-<6 hex of the host>` |
| self-hosted | Compose service `caelo-staging-gateway` (port 8091) | the admin's `output/staging`, mounted read-only at `/srv/staging` | Caddy: the staging host → `reverse_proxy caelo-staging-gateway:8091` for every path; Caddy serves no staging file itself |
| aws, azure | none | none | refused honestly until #749 / #750 (`staging-domain enable` says so) |

Nothing else leads to the staged files: no public bucket, no preview channel, no Cloud Run domain mapping (the converge deletes the old one, #650), and Caddy has no root for staging.

## What the staging gateway may do

- **One credential.** `PUBLIC_DATABASE_URL` is `public_staging_role` on `cms_public_staging`; its password is the CLI-generated `public-staging-role-password` (its account's only `secretAccessor`).
- **No gate key in its env.** The admin publishes the staging gate's key to `cms_public_staging` (the staging projection). The live gateway loses `CAELO_STAGING_GATE_SECRET` and its account's access to `staging-gate-secret` (a retired binding, removed after the rolls). The key is moved, never re-minted, so crawler credentials keep working. Self-hosted installs get a key of their own once (`.caelo/config.json` `stagingGateSecret`), on the admin only.
- **Storage.** `CAELO_STAGING_STORAGE` is `gs://<staging bucket>` (GCP) or `file:///srv/staging` (self-hosted). Its account holds `roles/storage.objectViewer` on the staging bucket and nothing on media or the static bucket.
- **Trusted hops.** `STAGING_GATEWAY_TRUSTED_PROXY_HOPS` in `packages/provisioning/src/stack-contract.ts`: gcp 2 (`<client>,<LB IP>`), gcp-firebase 1 (Cloud Run's front end; IP-allowlist mode is refused there, #1325), self-hosted 1 (Caddy). A test pins the table.
- **Scale.** At most `DEFAULT_STAGING_GATEWAY_MAX_INSTANCES` (the connection budget's share for `public_staging_role`), minimum 0, request-based CPU, 60 s timeout (Firebase cuts a rewrite at 60 s). While no staging host is set it answers the fixed 404 on every path but `/healthz` (E14 a, [gateway-hardening.md](./gateway-hardening.md)).

The quality audit's Lighthouse job does not go through the staging gateway (#875): its account reads the served build slot of the staging bucket directly (`objectViewer` on the staging bucket, both GCP providers, no static-bucket read any more).

## Who creates what

The stacks declare only the staging gateway's service account, its secret binding and its telemetry roles. Everything else is CLI-owned (`packages/provisioning/src/staging-gateway-setup.ts`), like the audit and capture jobs:

- `ensureStagingGatewayService` — account, secret access, the gcp-firebase bucket and the admin's write on it, the staging gateway's read on it, the service (deployed once with the release's gateway image, VPC egress copied from the live gateway), `allUsers` invoker. Runs in the upgrade's pre-plan step (`ensureReleaseServices`), because the app-roll rolls four services from contract 20 on (admin, gateway, staging gateway, MCP-Auth-Proxy; the staging gateway takes the gateway's image).
- `ensureStagingGatewayEdge` — the Hosting site or the load-balancer pieces above, idempotently. Runs in the converge before the roll, in the wizard after the first `up`, and in `cms-provision staging-domain enable` (which also switches on password protection the first time and prints the DNS records).

The `gcp` stack's URL map declares the `staging` host rule and matcher (pointing at the static bucket at creation) and ignores `pathMatchers[2].defaultService`, which the CLI moves to the staging gateway's backend; the HTTPS proxy ignores `sslCertificates`, to which the CLI adds the staging certificate.

## DNS

The staging host needs its own records: on gcp-firebase the ones the staging site's custom domain asks for (`requiredDnsUpdates`), on gcp an A record to the load balancer's address. The converge and the wizard print them; Settings → Updates shows them as well.
