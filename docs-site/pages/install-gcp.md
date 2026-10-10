---
slug: install-gcp
template: doc-page
status: published
seo:
  title: Install on Google Cloud — Caelo CMS
  description: Deploy Caelo to GCP with one command. Cloud SQL HA + Cloud Storage + Cloud CDN + Cloud Run + Secret Manager via Pulumi.
---

# Install — Google Cloud

The `--provider gcp` adapter spins up a managed stack that mirrors the self-hosted compose stack feature-for-feature, with HA + autoscaling + managed TLS.

## What gets provisioned

| Layer | GCP service | Notes |
|---|---|---|
| Database | **Cloud SQL Postgres 16** (Regional HA) | Automatic failover, daily snapshots, 7-day PITR |
| Object storage | **Cloud Storage** | The public site's bucket (CDN-fronted) and a private media bucket. The media bucket is mounted into the admin as a Cloud Storage volume, so uploads survive new revisions and scale-to-zero and every admin instance sees the same files |
| Edge | **Cloud CDN** + Load Balancer | TLS via Google-managed cert; A/B edge split honoured |
| Compute (admin + gateway) | **Cloud Run** | Autoscaling, scales to zero idle |
| Secrets | **Secret Manager** | Bearer tokens, OAuth secrets, AI provider keys |
| Network | **VPC** + Serverless VPC Access | Cloud Run → Cloud SQL via private IP only |
| DNS | **Cloud DNS** zone (you delegate NS) | Records surfaced at `/security/dns` |

## Prerequisites

- A GCP project with billing enabled
- A service account with the roles the adapter needs:
  - `roles/run.admin`, `roles/cloudsql.admin`, `roles/storage.admin`,
    `roles/secretmanager.admin`, `roles/iam.serviceAccountUser`,
    `roles/compute.networkAdmin`, `roles/dns.admin`
- The `gcloud` CLI authenticated as that service account (or `GOOGLE_APPLICATION_CREDENTIALS` pointing at its JSON key)
- A domain you control

## Run the provisioner

```bash
bunx @caelo-cms/provisioning --provider gcp \
  --project caelo-prod \
  --region europe-west1 \
  --domain caelo.example.com \
  --owner-email you@example.com \
  --anthropic-key sk-ant-...
```

Wall-clock: about 10 minutes (mostly Cloud SQL HA setup).

## Choosing the region

The region decides where your database, uploads, secrets and services live: that matters for data residency (GDPR) and for latency to your editors. The provisioner asks for it before it creates anything that costs money:

- It preselects the default region of your `gcloud` CLI (`gcloud config get run/region`, then `compute/region`). Without one it suggests `europe-west1` (Belgium).
- It only offers regions where every service the install needs is available: Cloud Run, Cloud SQL, Secret Manager, Artifact Registry and Cloud Scheduler (the hourly [IAP sync](#who-can-open-the-admin-google-iap)). `--provider gcp-firebase` also needs Cloud Run domain mappings for `admin.<your domain>`, which Google offers in fewer regions: `asia-east1`, `asia-northeast1`, `asia-southeast1`, `europe-west1`, `europe-west4`, `us-central1`, `us-east1`, `us-east4` and `us-west1`.
- The cost table shows the region you picked. Its prices are `europe-west1` list rates; other regions can cost a little more.
- With `--non-interactive`, pass `--region`. Without it the provisioner stops and lists the regions you can use.

**The region is fixed after install.** Moving an install means migrating its Cloud SQL database, buckets, secrets and images, which Caelo does not do. The region is recorded in `~/.caelo-<install-id>/install.json`; re-running the provisioner or `upgrade` with a different `--region` stops with an explanation instead of touching anything. To run somewhere else, provision a new install in that region.

What you'll see:

1. Pulumi previews the stack; you confirm
2. VPC + private services connection comes up
3. Cloud SQL provisions in regional-HA mode
4. Buckets + Secret Manager seeded
5. Cloud Run services deployed
6. Load balancer + Cloud CDN configured; managed TLS cert provisions (~5 min after DNS resolves)
7. The admin migrates the schema + seeds the system actor
8. Owner-bootstrap URL printed

## DNS

The provisioner emits the exact records you need. They're surfaced at `https://caelo.example.com/security/dns` after the install — but TLS won't issue until you actually create them. Two records you'll always need:

- `A` record for `caelo.example.com` → load balancer IP
- `CNAME` for `staging.caelo.example.com` → load balancer IP

If you delegated the entire zone via `gcloud dns managed-zones create` to the install, the provisioner adds both automatically. If you kept your registrar's nameservers, copy the records from `/security/dns` and paste them at the registrar.

## Three environments

`bunx @caelo-cms/provisioning --provider gcp --env staging` brings up a parallel staging stack: separate Cloud Run service, separate Cloud SQL instance (or Cloud SQL Smaller-tier — configurable), separate `staging.caelo.example.com` host, `X-Robots-Tag: noindex` header.

Production promotion goes through the **Ops** view in the admin (`/security/deployments` → "Promote staging → production"), not via Pulumi.

## Cost (rough)

A small docs-site-shaped install runs ~$45/mo on GCP:

- Cloud SQL `db-g1-small` HA: ~$30
- Cloud Run (low traffic, scales to zero idle): ~$3 — the admin runs with 2 GiB (`adminMemory`) for the [quality checks](/quality-gate); memory is billed only while an instance runs
- Quality checks (Lighthouse on the admin, a few Stages a day): ~$1
- Cloud Storage + Cloud CDN: ~$2 with cache hits
- Load balancer + IP: ~$10

Heavier installs scale Cloud Run + Cloud SQL tier; the admin's `/security/costs` aggregates AI spend separately.

## Who can open the admin (Google IAP)

The admin sits behind Google Identity-Aware Proxy: Google checks who you are before Caelo's own login page even loads. The provisioner lets the Owner through. Everyone else gets through the moment you add them as a Caelo user:

- **Add a user** at `/security/users`, or ask the AI ("invite anna@example.com as an editor") and click **Approve** on the card. Within a minute that email may pass IAP and sign the MCP credential, so they can use the browser and MCP.
- **Delete a user**, or take away their last role (also by deleting a role), and both are removed again.
- Use the person's **Google account** address (Gmail or Google Workspace). IAP only admits Google identities.

### How it works, and the trust boundary

The admin does **not** change IAP itself. Its service account holds no rights over IAM policies. A separate Cloud Run job, `caelo-production-operator-access-sync`, runs as its own service account and is the only principal that may change who passes IAP on the admin and who may sign as `caelo-mcp`. Each run:

1. reads the user list from the database through a read-only database role (`operator_access_reader`, which can see user emails and role assignments and nothing else) using Cloud SQL IAM authentication, with no password;
2. makes `roles/iap.httpsResourceAccessor` on the admin and `roles/iam.serviceAccountTokenCreator` on `caelo-mcp` hold **exactly** one `user:` entry per active user with a role, plus the install's allowlist (the Owner) and `caelo-mcp` itself on IAP;
3. **removes everything else** on those two roles: `allUsers`, `allAuthenticatedUsers`, whole domains, groups, stray users and hand-written conditional bindings. Each removal is logged as a warning in the job's log.

The admin may only **start** the job (`roles/run.jobsExecutor` on that one job, which does not allow overriding its command, arguments or environment) and read how its runs went. It starts the job after every approved user or role change, and when you click **Re-sync Google IAP access** at `/security/users`. Cloud Scheduler also runs it every hour, so a missed run or a hand-edited IAP policy is repaired on its own.

So an admin compromise can add users to the database, and through them single email addresses to IAP, but it cannot change the IAP policy directly, make the admin public or grant any other role. The job only ever grants individual user emails.

If a run fails, the approval result and `/security/users` say so, with a link to the run's log. You never find out from a 403. Fix the cause the log names, then click **Re-sync Google IAP access**.

Installs created before this feature get the job on their next `bunx @caelo-cms/provisioning upgrade`. The upgrade also removes the operator-access rights an earlier pre-release build gave the admin's own service account. Until you upgrade, an approved user change reports that Google IAP could not be updated.

## Admin on your own domain (`gcp-firebase`)

With `--provider gcp-firebase`, the admin starts out on its Cloud Run URL (`https://caelo-production-admin-….run.app`). To serve it at `admin.<your domain>`:

```bash
bunx @caelo-cms/provisioning admin-domain enable
```

Google only maps a domain for a verified owner of it. If you have not verified yours yet, the command opens Search Console for you: add the TXT record it shows at your registrar, click **Verify**, then run the command again. It creates the mapping as your own gcloud account and prints the DNS record to add (usually a `CNAME` to `ghs.googlehosted.com.`); TLS follows once DNS resolves. Running it again is safe. With more than one install on the machine, pick one with `--install <install-id>`. (`--provider gcp` needs none of this: its load balancer serves `admin.<your domain>` from the start.)

## Day-2 operations

| Task | How |
|---|---|
| Upgrade to a new release | `bunx @caelo-cms/provisioning upgrade` (see below) |
| Give someone admin access | Add them at `/security/users` (or ask the AI) — IAP follows automatically |
| Serve the admin at `admin.<domain>` (gcp-firebase) | `bunx @caelo-cms/provisioning admin-domain enable` |
| Read logs | Cloud Logging — filter by `resource.labels.service_name="caelo-admin-prod"` |
| Restore from PITR | `gcloud sql backups restore` — see [`docs/incident-response.md`](https://github.com/caelo-cms/caelo-cms/blob/main/docs/incident-response.md) §F |
| Rotate the AI provider key | Owner → `/security/ai` (stored encrypted in the database) |
| Rotate a runtime secret | `bunx @caelo-cms/provisioning rotate-secret <postgres-password\|public-role-password\|gateway-role-password\|internal-secret\|tool-approval-secret>` — stores a new value in Secret Manager (for a database password also on its role: `postgres-password` is `admin_role`'s, the other two the gateway's `public_role` and `gateway_role`) and rolls the services that read it |
| Scale Cloud Run | `gcloud run services update caelo-admin-prod --max-instances=20` |

### What `upgrade` does

`upgrade` brings an existing install to what a fresh install of the target release looks like, without re-running the full provisioning:

1. Resolves the release images and verifies their signatures.
2. Ensures the gateway's own service account and the generated runtime secrets (the internal-API and tool-approval keys, and the gateway's two database role passwords) exist, creating them once in Secret Manager. Then ensures the IAM bindings and Cloud CDN settings the release's infrastructure declares — each service account can read exactly the secrets its service uses. It only adds what is missing here (a binding a release retired — the gateway's former access to the admin's database password — is removed only at the very end, once both services run without it). If a binding the install needs can't be added (usually a missing IAM permission on your gcloud account), it stops here: bindings it already added stay (they are additive and harmless), but no migration has run and no traffic has shifted. Fix the reported binding and re-run; `upgrade` skips what is already in place.
3. Applies the database migrations.
4. Rolls the admin and gateway to the new images. The admin's memory is raised to the release's default (2 GiB for the [quality checks](/quality-gate)) if it runs with less; a larger value you set is kept. Configuration the release expects (for example the public site URL your canonical tags and sitemap use, or the media bucket mounted into the admin as a Cloud Storage volume) is applied in the same step, so it lands in the same new revision and rolls back with it. Secrets are Secret Manager references, never plain values: the database URLs carry no password, and the password reaches the services from Secret Manager.
5. Records the images it rolled to. Re-running the installer later keeps that release instead of switching to the newest one — version changes always go through `upgrade`.

#### The gateway's own database logins

The public API gateway never holds the admin's database credential. It connects as two roles of its own: `public_role` on `cms_public` and `gateway_role` on `cms_admin` — a login that can read the gateway's settings and the plugin registry and append to its own request log, rate limits, captcha challenges and plugin audit, and nothing else. Each role has its own password in Secret Manager (`postgres-password` for the admin, `public-role-password` and `gateway-role-password` for the gateway), and the gateway's service account can read only the gateway's two.

An install from before this change converges on its first `upgrade`, without anything for you to do:

- the migrations create `gateway_role`, and `upgrade` gives it its password;
- right before the gateway rolls, `public_role` moves off the admin's password onto its own (if the gateway's roll fails, it is put back, so the rolled-back gateway keeps working);
- the gateway's new revision gets `GATEWAY_DATABASE_URL` and loses `ADMIN_DATABASE_URL` in the same step;
- after both services rolled, the gateway's service account loses its access to the admin's password.

`upgrade` then suggests `rotate-secret postgres-password`: until that upgrade the gateway knew the admin's password. Run it.

## Common issues

- **TLS cert stuck on `provisioning`** — DNS hasn't propagated. `dig caelo.example.com` should return the load balancer IP. Wait 10-30 min; Google-managed certs poll for a valid challenge.
- **`Cannot allocate memory` from Cloud SQL** — bump tier from `db-g1-small` to `db-custom-2-7680` via `gcloud sql instances patch`.
- **A new user gets "You don't have access" from Google** — the approval result says why. Most often their email is not a Google account, or the install predates operator access: run `bunx @caelo-cms/provisioning upgrade` once, then click **Re-sync Google IAP access** at `/security/users`.
- **Stage fails with "the stored files of … media asset(s) are missing"** — the install ran a release that kept media on the admin container's own disk, which Cloud Run discards on every new revision and scale-to-zero. Run `bunx @caelo-cms/provisioning upgrade`: it mounts the media bucket into the admin (execution environment gen2, a Cloud Storage volume named `media` of the `<project>-caelo-production-media` bucket at `/app/apps/admin/data/media`). If you already added exactly that volume by hand, upgrade keeps it. Files lost before the upgrade cannot be recovered from Cloud Run; ask the AI to "fix the missing media" — it lists them (`list_missing_media`), re-imports what came from a URL, and tells you which files to re-upload at `/content/media` (re-uploading the same file restores it on every page that uses it).
- **The admin refuses to start: "media storage is not durable"** — the admin found no persistent volume at its media root. Run `bunx @caelo-cms/provisioning upgrade`, which adds it.
- **Cloud Run cold-starts feel slow** — set `--min-instances=1` on the admin service. Costs ~$15/mo extra; eliminates first-request latency.

## Next

- [AWS install →](/install-aws)
- [Architecture →](/architecture)
- Incident response: [`docs/incident-response.md`](https://github.com/caelo-cms/caelo-cms/blob/main/docs/incident-response.md)
