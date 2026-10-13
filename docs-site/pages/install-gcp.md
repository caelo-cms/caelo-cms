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
| Edge | **Cloud CDN** + Load Balancer | TLS via Google-managed cert |
| Compute (admin + gateway) | **Cloud Run** | Autoscaling, scales to zero idle |
| Secrets | **Secret Manager** | Bearer tokens, OAuth secrets, AI provider keys |
| Network | **VPC** + Serverless VPC Access | Cloud Run → Cloud SQL via private IP only |
| DNS | **Cloud DNS** zone (you delegate NS) | Records surfaced at `/settings/dns` |

### Default firewall rules (removed)

When Compute Engine is enabled, Google gives every new project a `default` VPC network with four pre-populated firewall rules:

| Rule | Allows | From |
|---|---|---|
| `default-allow-ssh` | tcp:22 | `0.0.0.0/0` (the whole internet) |
| `default-allow-rdp` | tcp:3389 | `0.0.0.0/0` |
| `default-allow-icmp` | icmp (ping) | `0.0.0.0/0` |
| `default-allow-internal` | every tcp/udp port + icmp | `10.128.0.0/9` (other instances on the network) |

Caelo runs no virtual machines and does not use the `default` network: it creates its own VPC for the private Cloud SQL connection, and Cloud Run reaches it through Direct VPC egress on that VPC's subnet. So these rules give nothing access today. They are still open ports on the books: security audits (ISO 27001 and similar) flag them, and the first VM anyone adds to the project would inherit them.

So the provisioner deletes all four, on both `--provider gcp` and `--provider gcp-firebase`: a fresh install right after `pulumi up`, an existing install on its next `bunx @caelo-cms/provisioning upgrade`. It only deletes a rule that is exactly what Google created (ingress on the `default` network, from exactly the source range above, allowing exactly the protocols and ports above, applying to every instance). `default-allow-internal` carries the traffic between VMs on the `default` network, so it is only deleted when no VM in the project is on that network and the project is not a [Shared VPC](https://cloud.google.com/vpc/docs/shared-vpc) host (whose service projects' VMs could use it); otherwise the rule stays and the provisioner says why. The network itself stays. A project without the rules, or without Compute Engine, is left as is.

## Prerequisites

- A Google account that can create a project and link billing (or that is Owner of an existing project with billing enabled)
- The `gcloud` CLI, signed in as that account (`gcloud auth login`)
- Application Default Credentials for the same account (`gcloud auth application-default login`). The provisioner checks for them and offers to run the login for you; Cloud Shell has them already.
- A domain you control

You do not create a service account or download a key. The provisioner creates `caelo-provisioner@<project>.iam.gserviceaccount.com` with the roles the stack needs, and lets your own account [impersonate](#no-service-account-key-on-your-machine) it.

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
6. Load balancer + Cloud CDN configured
7. DNS records for the admin host set (or printed and polled), then the provisioner waits for the admin's TLS certificate (15-60 min after DNS resolves; Ctrl-C is safe, re-running resumes the wait)
8. The admin migrates the schema + seeds the system actor
9. Final summary: the DNS records (in two groups, see below) and the next steps — Owner setup URL, AI key, MCP

## DNS

The provisioner prints the exact records your install needs, in two groups:

- **Set now** — hosts nothing live uses yet: `admin.<your domain>`, the staging host, and verification `TXT` records (on `gcp-firebase` also `_acme-challenge` records, which let Firebase issue the main domain's certificate before you switch). Set these during the install. On `--provider gcp` the provisioner sets them itself through the Cloudflare API when `CLOUDFLARE_API_TOKEN` is set; otherwise it prints them and waits until they resolve.
- **Only at go-live** — the `A` / `AAAA` / `CNAME` records of `<your domain>` and `www.<your domain>`. They move the public website to Caelo. **If a site is live on that domain today, setting them during the install takes it offline**: Caelo serves nothing there until your first publish. Replace the existing records once the new site is published. The provisioner never sets these automatically.

On `--provider gcp`, the admin has its own certificate, so it gets HTTPS as soon as `admin.<your domain>` resolves; the main domain's certificate is issued after the go-live switch (expect 15-60 minutes of HTTPS errors on the main domain right after it). On `gcp-firebase`, Firebase Hosting issues the main domain's certificate itself.

After the install, the records are also listed in the admin at `/settings/domains`, where the AI can check them for you (`verify_dns_records`).

## No service-account key on your machine

The infrastructure (Pulumi) runs as the `caelo-provisioner` service account, but nothing on your machine holds a key for it. Instead:

- your gcloud account gets `roles/iam.serviceAccountTokenCreator` on `caelo-provisioner` — on that one account only, not on the project;
- each infrastructure run uses your Application Default Credentials to ask Google for a short-lived token of `caelo-provisioner` (impersonation). The token is renewed as it runs out, so a long `pulumi up` does not fail after an hour, and it is never printed or written to disk;
- other credential variables in your shell (`GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CREDENTIALS`, `GOOGLE_OAUTH_ACCESS_TOKEN`, …) are ignored for these runs, so a stray key file can't take their place.

A leaked laptop, backup or synced folder therefore leaks no lasting access to your project: impersonating needs your Google login, and removing your account's role on `caelo-provisioner` ends it.

**Installs created before this change** kept a JSON key at `~/.caelo-<install-id>/secrets/sa-key.json`. The next `bunx @caelo-cms/provisioning upgrade` (or installer re-run) removes it, before anything else changes:

1. it gives your gcloud account the impersonation role above (or confirms it has it, without a condition) and checks that impersonating actually works — waiting a few minutes for a fresh grant to apply — so the key is never deleted before its replacement works;
2. it reads the key's id from the file and deletes exactly that key of `caelo-provisioner` in IAM — no other key; if the service account has other user-managed keys, it lists them with the command to delete each one, and leaves them alone;
3. it deletes the file and prints a "Service-account key removed" summary.

If a step fails, the upgrade stops before rolling anything and the key file stays where it is, so the next run can still match it. Running it again after it succeeded changes nothing.

## Where the install's state lives

Everything the provisioner needs to manage the install later lives **in the install's own GCP project**, not on your laptop:

- **`gs://<project>-caelo-ops`** — a Cloud Storage bucket in the install region with object versioning (every change to the state can be recovered for 30 days), uniform bucket-level access and public access prevention. `pulumi/` holds Pulumi's state, `install/` holds `install.json` (domain, region, the release the install runs, …) and `progress.json` (the steps the installer finished).
- **Cloud KMS key `caelo/pulumi-state`** — encrypts the secrets inside Pulumi's state. There is no passphrase to keep safe.
- **Access** — your gcloud account and `caelo-provisioner` get access to the bucket (`roles/storage.objectAdmin`) and to the key (`roles/cloudkms.cryptoKeyEncrypterDecrypter`); nobody else is granted anything, the bucket's default read access for project Viewers and Editors is removed, and the provisioner refuses a bucket that grants `allUsers` or `allAuthenticatedUsers`. Project Owners can always reach it through their project role.

The cost confirmation lists both (less than $0.10/mo together); the installer creates them right after you confirm and checks them on every re-run. `~/.caelo-<install-id>/` on your machine keeps only a copy of `install.json` and `progress.json`; the bucket is the source of truth, and nothing in either file is a secret — the installer refuses to write one there.

**Installs created before this change** keep their state in `~/.caelo-<install-id>/state/` with the passphrase in `secrets/pulumi-passphrase`; a re-run or `upgrade` never moves it on its own (`upgrade` reminds you). Move it with `state migrate`.

### Moving an existing install's state into its project

```bash
bunx @caelo-cms/provisioning state migrate --install example.com --dry-run   # what it would do
bunx @caelo-cms/provisioning state migrate --install example.com
```

It needs the [Pulumi CLI](https://www.pulumi.com/docs/install/) on the machine (3.254.0 or newer uses `pulumi stack migrate`; older versions use export/import — both work), your gcloud login and Application Default Credentials. Step by step:

1. **Preflight** (read-only): the stack exists, has no pending operations from an interrupted run, and a preview shows **no changes**. A stack with drift can't be proven identical after the move, so it is refused with "Run upgrade first": run `upgrade`, re-run the installer for the install until it reports no changes, then migrate.
2. **Backup**: `~/.caelo-<install-id>/` is archived to `~/.caelo-backups/<install-id>-<time>.tar.zst` (`.tar.gz` without `zstd`), mode 600 — it contains the passphrase, keep it private.
3. **Target**: the bucket and KMS key are ensured as for a new install.
4. **Copy**: the stack is copied into the bucket and its secrets re-encrypted with the KMS key.
5. **Verify**: a preview of the copy shows no changes and its outputs (secrets included, compared by hash) match the original. If not, the copy is discarded and your local state stays in use — nothing else changed.
6. **Switch**: `install.json` records the new location (locally and in the bucket); `~/.caelo-<install-id>/state` is renamed to `state.migrated-<time>`, not deleted. Delete it (and the passphrase) once you are confident.

Running it again is safe: an install already in its project is left alone, and a half-finished copy from an interrupted run is replaced. To move the state back onto this machine: `state migrate --install example.com --to local` (same steps, in the other direction; it creates a passphrase if there is none).

### Managing an install from another machine

On a new laptop or in Cloud Shell, after `gcloud auth login` and `gcloud auth application-default login`:

```bash
bunx @caelo-cms/provisioning attach --project <gcp-project-id>
```

It reads the install's `install.json` from the bucket and sets up `~/.caelo-<install-id>/` with copies of it and `progress.json`. No secret is copied — none exists outside your Google login. `status`, `upgrade`, `backup` and re-running the installer then work from that machine. `attach` refuses to overwrite a directory that holds an un-migrated install's local state.

## After the install

The provisioner's summary ends with the next steps:

1. **Owner setup** — open the printed setup URL and sign in with the owner email (Google IAP lets only that account through at first).
2. **AI provider** — at `/settings/ai`, paste your Anthropic API key. It is stored encrypted in the database.
3. **MCP (optional)** — to drive Caelo from Claude Code or another MCP client, open `/settings/mcp`, click **New token** (scope `chat` lets Caelo's AI do the work; `admin` lets your own agent use Caelo's tools), copy the token (shown once) and run the `claude mcp add` command the page shows. Because the admin is behind Google IAP, run `gcloud auth application-default login` once on that machine. See [MCP](/mcp).

## Three environments

`bunx @caelo-cms/provisioning --provider gcp --env staging` brings up a parallel staging stack: separate Cloud Run service, separate Cloud SQL instance (or Cloud SQL Smaller-tier — configurable), separate `staging.caelo.example.com` host, `X-Robots-Tag: noindex` header.

Production promotion goes through the **Ops** view in the admin (`/settings/deployments` → "Promote staging → production"), not via Pulumi.

## Cost (rough)

A small docs-site-shaped install runs ~$45/mo on GCP:

- Cloud SQL `db-g1-small` HA: ~$30
- Cloud Run (low traffic, scales to zero idle): ~$3 — the admin runs with 2 GiB (`adminMemory`) for the [quality checks](/quality-gate); memory is billed only while an instance runs
- Quality checks (Lighthouse on the admin, a few Stages a day): ~$1
- Cloud Storage + Cloud CDN: ~$2 with cache hits
- Load balancer + IP: ~$10

Heavier installs scale Cloud Run + Cloud SQL tier; the admin's `/settings/costs` aggregates AI spend separately.

## Who can open the admin (Google IAP)

The admin sits behind Google Identity-Aware Proxy: Google checks who you are before Caelo's own login page even loads. The provisioner lets the Owner through. Everyone else gets through the moment you add them as a Caelo user:

- **Add a user** at `/settings/users`, or ask the AI ("invite anna@example.com as an editor") and click **Approve** on the card. Within a minute that email may pass IAP and sign the MCP credential, so they can use the browser and MCP.
- **Delete a user**, or take away their last role (also by deleting a role), and both are removed again.
- Use the person's **Google account** address (Gmail or Google Workspace). IAP only admits Google identities.

### How it works, and the trust boundary

The admin does **not** change IAP itself. Its service account holds no rights over IAM policies. A separate Cloud Run job, `caelo-production-operator-access-sync`, runs as its own service account and is the only principal that may change who passes IAP on the admin and who may sign as `caelo-mcp`. Each run:

1. reads the user list from the database through a read-only database role (`operator_access_reader`, which can see user emails and role assignments and nothing else) using Cloud SQL IAM authentication, with no password;
2. makes `roles/iap.httpsResourceAccessor` on the admin and `roles/iam.serviceAccountTokenCreator` on `caelo-mcp` hold **exactly** one `user:` entry per active user with a role, plus the install's allowlist (the Owner) and `caelo-mcp` itself on IAP;
3. **removes everything else** on those two roles: `allUsers`, `allAuthenticatedUsers`, whole domains, groups, stray users and hand-written conditional bindings. Each removal is logged as a warning in the job's log.

The admin may only **start** the job (`roles/run.jobsExecutor` on that one job, which does not allow overriding its command, arguments or environment) and read how its runs went. It starts the job after every approved user or role change, and when you click **Re-sync Google IAP access** at `/settings/users`. Cloud Scheduler also runs it every hour, so a missed run or a hand-edited IAP policy is repaired on its own.

So an admin compromise can add users to the database, and through them single email addresses to IAP, but it cannot change the IAP policy directly, make the admin public or grant any other role. The job only ever grants individual user emails.

If a run fails, the approval result and `/settings/users` say so, with a link to the run's log. You never find out from a 403. Fix the cause the log names, then click **Re-sync Google IAP access**.

Installs created before this feature get the job on their next `bunx @caelo-cms/provisioning upgrade`. The upgrade also removes the operator-access rights an earlier pre-release build gave the admin's own service account. Until you upgrade, an approved user change reports that Google IAP could not be updated.

## Admin on your own domain (`gcp-firebase`)

With `--provider gcp-firebase`, the admin starts out on its Cloud Run URL (`https://caelo-production-admin-….run.app`). To serve it at `admin.<your domain>`:

```bash
bunx @caelo-cms/provisioning admin-domain enable
```

Google only maps a domain for a verified owner of it. If you have not verified yours yet, the command opens Search Console for you: add the TXT record it shows at your registrar, click **Verify**, then run the command again. It creates the mapping as your own gcloud account and prints the DNS record to add (usually a `CNAME` to `ghs.googlehosted.com.`). Then it waits, with a spinner, until Google has issued the certificate — usually 15-60 minutes once the record resolves — and prints the admin login URL. You can stop it with Ctrl-C at any time: running the command again finds the mapping and resumes waiting. After 60 minutes it stops and prints how to check the status yourself (`dig +short admin.<your domain> CNAME`, `gcloud beta run domain-mappings describe --domain=admin.<your domain> --region=<region> --project=<project>`). Running it again is safe. With more than one install on the machine, pick one with `--install <install-id>`. (`--provider gcp` needs none of this: its load balancer serves `admin.<your domain>` from the start.)

## Protected staging on your own domain (`gcp-firebase`)

Every Stage is served on the staging host behind an access gate — the same artefacts Publish live ships, with only the host swapped (see [Protected staging](/staging-access)). The wizard asks for the host (default `staging.<your domain>`; `--staging-domain <host>` when non-interactive). The gateway serves it; map it once:

```bash
bunx @caelo-cms/provisioning staging-domain enable
```

It sets the host in the admin for you (no click under Settings → Domains needed), turns on basic-auth password protection the first time and prints the login once (`--rotate-staging-password` for a new one, `--show-staging-password` to see the current one; nothing is written to disk). To move staging to another host, pass `--staging-domain <new host>`; without the flag it maps the host the admin has stored, so a host changed under Settings → Domains is picked up. The host serves pages after the next Stage, and only *published* pages are staged — the command says so and lists draft pages. It works like `admin-domain enable` (same Search Console verification, run as your own gcloud account), opens the gateway's ingress for the domain mapping, and prints the DNS record to add (usually `CNAME staging → ghs.googlehosted.com.`). Like `admin-domain enable`, it then waits for the certificate (Ctrl-C safe, re-run to resume). Running it again is safe. Who may open staging is set in the admin under **Settings → Staging access**.

## Day-2 operations

| Task | How |
|---|---|
| Upgrade to a new release | `bunx @caelo-cms/provisioning upgrade` (see below) |
| Move an older install's state into its project | `bunx @caelo-cms/provisioning state migrate --install <id or domain>` ([details](#moving-an-existing-installs-state-into-its-project)) |
| Manage the install from another machine | `bunx @caelo-cms/provisioning attach --project <gcp-project-id>` |
| Give someone admin access | Add them at `/settings/users` (or ask the AI) — IAP follows automatically |
| Serve the admin at `admin.<domain>` (gcp-firebase) | `bunx @caelo-cms/provisioning admin-domain enable` |
| Serve the staging host (gcp-firebase) | `bunx @caelo-cms/provisioning staging-domain enable` |
| Read logs | Cloud Logging — filter by `resource.labels.service_name="caelo-admin-prod"` |
| Back up the database now | `bunx @caelo-cms/provisioning backup` — prints the backup id and its restore command (`gcp` and `gcp-firebase`) |
| Restore from PITR | `gcloud sql backups restore` — see [`docs/incident-response.md`](https://github.com/caelo-cms/caelo-cms/blob/main/docs/incident-response.md) §F |
| Rotate the AI provider key | Owner → `/settings/ai` (stored encrypted in the database) |
| Rotate a runtime secret | `bunx @caelo-cms/provisioning rotate-secret <postgres-password\|public-role-password\|gateway-role-password\|internal-secret\|tool-approval-secret\|staging-gate-secret>` — stores a new value in Secret Manager (for a database password also on its role: `postgres-password` is `admin_role`'s, the other two the gateway's `public_role` and `gateway_role`) and rolls the services that read it |
| Scale Cloud Run | `gcloud run services update caelo-admin-prod --max-instances=20` |

### What `upgrade` does

`upgrade` brings an existing install to what a fresh install of the target release looks like, without re-running the full provisioning:

1. Resolves the release images and verifies their signatures.
2. Takes an on-demand Cloud SQL backup and prints its id. This is the first thing `upgrade` changes: if the backup fails, it stops with the reason and nothing else has happened. The id comes back in the restore command `upgrade` prints if it has to roll back after the migrations ran.
3. Moves an older install to the [keyless provisioner](#no-service-account-key-on-your-machine): ensures your gcloud account may impersonate `caelo-provisioner` and deletes the long-lived key file and its IAM key. On an install that already runs keyless this only confirms the role.
4. Ensures the gateway's own service account and the generated runtime secrets (the internal-API and tool-approval keys, and the gateway's two database role passwords) exist, creating them once in Secret Manager. Then ensures the IAM bindings and Cloud CDN settings the release's infrastructure declares — each service account can read exactly the secrets its service uses. It only adds what is missing here (a binding a release retired — the gateway's former access to the admin's database password — is removed only at the very end, once both services run without it). The one other thing it removes is [the default network's pre-populated firewall rules](#default-firewall-rules-removed); a failure there only warns. If a binding the install needs can't be added (usually a missing IAM permission on your gcloud account), it stops here: bindings it already added stay (they are additive and harmless), but no migration has run and no traffic has shifted. Fix the reported binding and re-run; `upgrade` skips what is already in place.
5. Applies the database migrations.
6. Rolls the admin and gateway to the new images. The admin's memory is raised to the release's default (2 GiB for the [quality checks](/quality-gate)) if it runs with less; a larger value you set is kept. Configuration the release expects (for example the public site URL your canonical tags and sitemap use, or the media bucket mounted into the admin as a Cloud Storage volume) is applied in the same step, so it lands in the same new revision and rolls back with it. Secrets are Secret Manager references, never plain values: the database URLs carry no password, and the password reaches the services from Secret Manager.
7. Checks the new revisions: the admin answers `/_caelo/health?deep=1` (both databases reachable, every migration the image ships applied, the expected version) through IAP, and the gateway answers `/api/_caelo/health?deep=1` (its database logins work, same version). If either check fails, both services go back to the revisions that served before and `upgrade` prints the backup id with its restore command. Restore only if the previous release no longer works against the migrated schema — restoring overwrites everything written since the backup. Before the migrations, `upgrade` checks that it can reach both health checks at all, so an access problem stops it before anything changed. `--skip-health-check` rolls with Cloud Run's readiness check only (for example to a release older than the deep health check).
8. Records the images it rolled to. Re-running the installer later keeps that release instead of switching to the newest one — version changes always go through `upgrade`. When every infrastructure step succeeded, it also records the infrastructure version the install now has (`infraContractVersion` in `install.json`), which in-product updates check before they install a release.

The health check reaches the IAP-protected admin the way MCP clients do: it signs a short-lived credential as the install's `caelo-mcp` service account, which `upgrade` lets every IAP-allowlisted user sign as. Run `upgrade` with an account that can open the admin.

**Several installs on one machine.** `upgrade`, `status`, `backup`, `rotate-secret`, `truncate` and `destroy` never guess which install you mean. With more than one install under `~/.caelo-*`, they ask in the terminal which one to act on; `upgrade`, `status` and `backup` also offer "All installs", which runs them one after another and stops at the first that fails. In scripts, name the install with `--install <install-id or domain>`, for example `bunx @caelo-cms/provisioning upgrade --install example.com`, or `--install all`.

#### The gateway's own database logins

The public API gateway never holds the admin's database credential. It connects as two roles of its own: `public_role` on `cms_public` and `gateway_role` on `cms_admin` — a login that can read the gateway's settings, the plugin registry and the approved comments a page already shows, append to its own request log, rate limits, captcha challenges and plugin audit, and nothing else. Each role has its own password in Secret Manager (`postgres-password` for the admin, `public-role-password` and `gateway-role-password` for the gateway), and the gateway's service account can read only the gateway's two.

An install from before this change converges on its first `upgrade`, without anything for you to do:

- the migrations create `gateway_role`, and `upgrade` gives it its password;
- right before the gateway rolls, `public_role` moves off the admin's password onto its own (if the gateway's roll fails, it is put back, so the rolled-back gateway keeps working);
- the gateway's new revision gets `GATEWAY_DATABASE_URL` and loses `ADMIN_DATABASE_URL` in the same step;
- after both services rolled, the gateway's service account loses its access to the admin's password.

`upgrade` then suggests `rotate-secret postgres-password`: until that upgrade the gateway knew the admin's password. Run it.

#### No secrets in `~/.caelo-<install-id>/`

The install directory on your machine keeps secrets only in `secrets/` (the Anthropic API key and, for an install whose [state](#where-the-installs-state-lives) is still on this machine, the Pulumi passphrase) and in Pulumi's encrypted state. It holds no service-account key: infrastructure runs [impersonate](#no-service-account-key-on-your-machine) `caelo-provisioner`. `progress.json` (where the installer records the steps it finished, so a re-run resumes) and `install.json` hold no passwords, database URLs with credentials or the Owner setup link; the installer reads those from Secret Manager or the Pulumi stack when it needs them.

Installers before this change stored the database URLs, with `admin_role`'s and `public_role`'s passwords, and the Owner setup link in `progress.json`. The next `upgrade` (or installer re-run) removes them from the file, keeps every finished step, and tells you which password to rotate, with the exact command, for example `bunx @caelo-cms/provisioning rotate-secret postgres-password --install example.com`. Run the commands it prints: copies of the old file may sit in backups or synced folders. The setup link needs no rotation; it expires after 24 hours and stops working once the Owner account exists.

## Common issues

- **TLS cert stuck on `provisioning`** — DNS hasn't propagated. `dig +short admin.caelo.example.com` should return the load balancer IP (`gcp`) or `ghs.googlehosted.com.` (`gcp-firebase` admin mapping). Wait 15-60 min; Google-managed certs poll for a valid challenge. The main domain's certificate on `gcp` only validates after its go-live records point at the load balancer.
- **`Constraint constraints/gcp.resourceLocations violated … in [global]`** — your organization only allows certain locations. New installs keep every secret in the install region, so this does not occur there. Installs created before that keep their existing automatic-replication secrets; when the installer or `upgrade` adds a secret and the policy refuses automatic replication, it creates that secret in the install region instead and says so in its output.
- **Site shows Firebase's "Site Not Found" although DNS is correct (`gcp-firebase`)** — when the custom domain was created while DNS still pointed at the old host, Firebase can stop re-checking it and leave it at `HOST_MISMATCH` / `OWNERSHIP_PENDING`. The Domains page (`/settings/domains`) and the AI's `list_domains` mark such a domain **stuck — reconnect recommended**: click **Reconnect** there, or let the AI propose it and approve in the chat. Caelo deletes and re-creates the custom domain (it is not serving yet, so nothing goes offline), and once it is active re-releases the live version so Firebase's CDN drops the cached 404.
- **`Cannot allocate memory` from Cloud SQL** — bump tier from `db-g1-small` to `db-custom-2-7680` via `gcloud sql instances patch`.
- **A new user gets "You don't have access" from Google** — the approval result says why. Most often their email is not a Google account, or the install predates operator access: run `bunx @caelo-cms/provisioning upgrade` once, then click **Re-sync Google IAP access** at `/settings/users`.
- **Stage fails with "the stored files of … media asset(s) are missing"** — the install ran a release that kept media on the admin container's own disk, which Cloud Run discards on every new revision and scale-to-zero. Run `bunx @caelo-cms/provisioning upgrade`: it mounts the media bucket into the admin (execution environment gen2, a Cloud Storage volume named `media` of the `<project>-caelo-production-media` bucket at `/app/apps/admin/data/media`). If you already added exactly that volume by hand, upgrade keeps it. Files lost before the upgrade cannot be recovered from Cloud Run; ask the AI to "fix the missing media" — it lists them (`list_missing_media`), re-imports what came from a URL, and tells you which files to re-upload at `/content/media` (re-uploading the same file restores it on every page that uses it).
- **The admin refuses to start: "media storage is not durable"** — the admin found no persistent volume at its media root. Run `bunx @caelo-cms/provisioning upgrade`, which adds it.
- **"not removed: firewall rule default-allow-internal …" with "VM instance(s) are on the default network"** — someone runs VMs on the project's `default` network, and deleting the rule would cut the traffic between them, so the provisioner left it in place and lists the VMs. Caelo itself puts nothing there. If the VMs do not need to talk to each other, delete the rule with the `gcloud compute firewall-rules delete …` command the message prints. If they do, replace it with a narrower rule under another name (only the ports and target tags they need), then delete `default-allow-internal`; the warning stops. If the message says the VMs could not be listed, your gcloud account needs `compute.instances.list` (for example `roles/compute.viewer`). If the message says the project is a **Shared VPC host**, VMs in its service projects may use the `default` network; check them with `gcloud compute shared-vpc list-associated-resources <project>` and delete the rule yourself only if none of them do.
- **"not removed: firewall rule default-allow-ssh …" (or `default-allow-rdp`, `default-allow-icmp`, `default-allow-internal`)** — a rule with that name exists but is not the one Google created (for example its source range was narrowed to an office IP, or it targets tagged VMs), so the provisioner left it in place; the message shows how it differs. If nothing on the project needs it, delete it with the `gcloud compute firewall-rules delete …` command the message prints. If it is intentional, give it another name (create a copy under the new name, then delete the old one) and the warning stops. If the message says the delete was denied, your gcloud account needs `compute.firewalls.delete` (for example `roles/compute.securityAdmin`); re-run with an account that has it.
- **`staging-domain enable` says the admin could not be updated** — the domain mapping is done; only the admin step failed, and the message names the fix. "Google IAP refused the request" or "sign an IAP token as caelo-mcp@…": your gcloud account is not (yet) let into the admin, or the install predates the `caelo-mcp` service account — run `cms-provision upgrade`, check that your account is a Caelo user, then re-run. "the admin has no /api/internal/staging/provision yet": the admin runs an older release — `cms-provision upgrade` first. "read the install's internal secret": your account needs `secretmanager.versions.access` on the project. The command is idempotent; re-running it never generates a second password unless you pass `--rotate-staging-password`.
- **`admin-domain enable` or `staging-domain enable` says the gcloud `beta` component is missing** — Cloud Run domain mappings for `gcp-firebase` are only available through `gcloud beta`. The command installs the `beta` component for you the first time ("Installing the gcloud "beta" component…", about a minute). If your gcloud came from a system package manager (apt/dnf `google-cloud-cli`, snap), gcloud cannot install components itself and the command stops with the package-manager command to run instead, for example `sudo apt-get install google-cloud-cli`; run it, then re-run the command. If the install fails because your Google Cloud CLI directory is not writable, run `gcloud components install beta` yourself (with `sudo` if needed). The provisioner runs gcloud with prompts disabled, so a missing component or any other question gcloud would ask shows up as an error instead of a silent hang.
- **"Could not let … impersonate caelo-provisioner@…" (installer or `upgrade`)** — your gcloud account may not change that service account's IAM policy. It needs `iam.serviceAccounts.setIamPolicy` on it, for example as project Owner or with `roles/iam.serviceAccountAdmin`. Ask a project Owner to run the `gcloud iam service-accounts add-iam-policy-binding … --role=roles/iam.serviceAccountTokenCreator` command the message prints (it names your account), then re-run. Nothing was changed and the old key file, if any, is still in place.
- **"No Application Default Credentials on this machine"** — infrastructure runs authenticate with your own Google login. Run `gcloud auth application-default login`, sign in as the account gcloud uses (`gcloud auth list`), then re-run. Interactive runs offer to start the login for you.
- **"Your Application Default Credentials (…) may not impersonate caelo-provisioner@…"** — if the message says they belong to another account than gcloud, run `gcloud auth application-default login` again as the gcloud account. If the role was granted moments ago, Google can take a few minutes to apply it: wait and re-run (the installer already waits about three minutes after a fresh grant). Otherwise the account lacks `roles/iam.serviceAccountTokenCreator` on `caelo-provisioner`; the message prints the command to grant it.
- **"Could not delete key … of caelo-provisioner@…" or "Could not list the keys …"** — your gcloud account needs `iam.serviceAccountKeys.list` and `iam.serviceAccountKeys.delete` (project Owner, or `roles/iam.serviceAccountKeyAdmin`). Re-run with such an account; the key file stays until its IAM key is gone, so nothing is lost by stopping here.
- **"… sa-key.json is a key for …, not for caelo-provisioner@…" or "has no service-account key id"** — the file is not the key the installer minted, so nothing was deleted. Check with `gcloud iam service-accounts keys list --iam-account=caelo-provisioner@<project>.iam.gserviceaccount.com --managed-by=user`, delete the key that file held if it is one, remove the file, then re-run.
- **Cloud Run cold-starts feel slow** — set `--min-instances=1` on the admin service. Costs ~$15/mo extra; eliminates first-request latency.
- **`state migrate` says "Run upgrade first" (drift or pending operations)** — the stack doesn't match what is deployed, so the copy can't be verified. Run `upgrade`, then the installer for the install (`bunx @caelo-cms/provisioning`, pick it) until it reports no changes, then migrate again. Nothing was changed.
- **`state migrate`: "Verification failed … The copy was discarded"** — the copy didn't match the original; your local state is still the one in use. Re-run; if it keeps failing, keep the backup from `~/.caelo-backups/` and open an issue with the message (it never contains secrets).
- **"Could not read gs://<project>-caelo-ops/install/…"** — your gcloud account has no access to the install's ops bucket. Ask a project Owner to run the installer or `state migrate` once with your account signed in, or grant you `roles/storage.objectAdmin` on the bucket and `roles/cloudkms.cryptoKeyEncrypterDecrypter` on the key `caelo/pulumi-state`.
- **"gs://<project>-caelo-ops exists but does not belong to project …"** — bucket names are global and another project holds that name. Delete or rename that bucket if it is yours; otherwise open an issue.
- **"Project … already has a Caelo install … whose state lives in gs://…"** — you ran the installer for an install that another machine set up. Run `attach --project <id>` instead.
- **Pulumi says it can't decrypt (`incorrect passphrase`, KMS permission denied)** — for an install in its project, check `gcloud auth application-default login` uses an account with access to the key; for a local install, `secrets/pulumi-passphrase` must be the original file (restore it from `~/.caelo-backups/`).

## Next

- [AWS install →](/install-aws)
- [Architecture →](/architecture)
- Incident response: [`docs/incident-response.md`](https://github.com/caelo-cms/caelo-cms/blob/main/docs/incident-response.md)
