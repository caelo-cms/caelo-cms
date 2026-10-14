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

So the provisioner deletes all four, on both `--provider gcp` and `--provider gcp-firebase`: a fresh install right after `pulumi up`, an existing install on its next [`upgrade`](#upgrading). It only deletes a rule that is exactly what Google created (ingress on the `default` network, from exactly the source range above, allowing exactly the protocols and ports above, applying to every instance). `default-allow-internal` carries the traffic between VMs on the `default` network, so it is only deleted when no VM in the project is on that network and the project is not a [Shared VPC](https://cloud.google.com/vpc/docs/shared-vpc) host (whose service projects' VMs could use it); otherwise the rule stays and the provisioner says why. The network itself stays. A project without the rules, or without Compute Engine, is left as is.

## One-click install from Cloud Shell

| Provider | |
|---|---|
| `gcp` — load balancer, Cloud CDN, Cloud Armor | [![Open in Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.svg)](https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/caelo-cms/install&cloudshell_git_branch=release-v0.10.47&cloudshell_tutorial=gcp.md) |
| `gcp-firebase` — Firebase Hosting, lower fixed cost | [![Open in Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.svg)](https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/caelo-cms/install&cloudshell_git_branch=release-v0.10.47&cloudshell_tutorial=gcp-firebase.md) |

The button opens [Google Cloud Shell](https://cloud.google.com/shell) in your browser with the [`caelo-cms/install`](https://github.com/caelo-cms/install) repository at the branch of this release, and a tutorial next to the terminal. You need nothing installed — only a Google account that can create a project and link billing, and your domain.

1. **Trust prompt.** Cloud Shell asks whether you trust the repository. It isn't Google's, so Cloud Shell opens it in a **temporary session without access to your Google credentials**, whichever you answer.
2. **Sign in:** `gcloud auth login --update-adc` (the tutorial's first step; `run.sh` asks again if you skip it).
3. **`./run.sh gcp`** (or `gcp-firebase`). Before anything runs it checks the checksums of the Bun and cosign builds it downloads, installs `@caelo-cms/provisioning` at exactly this release, and verifies with `npm audit signatures` that the packages were built by Caelo's release workflow from this repository's tag. Then the installer asks for the project id (created if it doesn't exist), domain, owner email and region, sets up the project with your login, and shows the [monthly cost](#cost-rough) — nothing billable exists until you confirm.
4. **The install job.** After you confirm, the installer verifies the release's signed manifest and starts the [install job](#where-the-install-runs-your-terminal-or-an-install-job) in your project; the tutorial's terminal shows its progress. When it reaches **Waiting for DNS**, set the records it prints at your registrar ([DNS](#dns)).
5. **Done.** The terminal shows the Owner setup link; continue with [After the install](#after-the-install).

**You can close the tab.** The install runs in your project, not in Cloud Shell: a closed tab, Ctrl-C or Cloud Shell's 40-minute idle timeout don't stop it. To follow it again, click the button again, sign in, and run `./run.sh` with the same project id — it attaches to the running install, shows the result of a finished one, or resumes one that stopped. A temporary Cloud Shell session keeps nothing in its home directory; everything the installer needs lives in the project.

The links are pinned to this Caelo release. Every release gets its own `release-v<version>` branch in `caelo-cms/install` (created and verified by that repository's `track-release` workflow within about 30 minutes of the release, and never moved afterwards). To manage the install later from Cloud Shell or a laptop, see [Managing an install from another machine](#managing-an-install-from-another-machine).

## Prerequisites

- A Google account that can create a project and link billing (or that is Owner of an existing project with billing enabled)
- The `gcloud` CLI, signed in as that account (`gcloud auth login`)
- Application Default Credentials for the same account (`gcloud auth application-default login`). The provisioner checks for them and offers to run the login for you; Cloud Shell has them already.
- A domain you control

You do not create a service account or download a key. The provisioner creates `caelo-provisioner@<project>.iam.gserviceaccount.com` with the roles the stack needs, and lets your own account [impersonate](#no-service-account-key-on-your-machine) it.

## Run the provisioner

```bash
bunx @caelo-cms/provisioning@latest --provider gcp \
  --project caelo-prod \
  --region europe-west1 \
  --domain caelo.example.com \
  --owner-email you@example.com \
  --anthropic-key sk-ant-...
```

Wall-clock: about 10 minutes (mostly Cloud SQL HA setup).

### Where the install runs: your terminal or an install job

The installer has two halves. The first needs **your** Google login: creating or picking the project, linking billing, enabling APIs, creating `caelo-provisioner`, the [state bucket + KMS key](#where-the-installs-state-lives), and the cost table you confirm. That half always runs in your terminal. The second half — `pulumi up`, the DNS and certificate waits, migrations, the Owner setup link — can run in one of two places:

| Mode | Where the second half runs | Default |
|---|---|---|
| **Install job** (`--install-job`) | A Cloud Run job `caelo-install` in your project, running as `caelo-provisioner` from the signed `caelo-ops` image of the same release (pinned by the digest in the release's [signed manifest](https://github.com/caelo-cms/caelo-cms/blob/main/packages/provisioning/src/release-manifest.ts)). Your terminal follows its log. | In Google Cloud Shell |
| **Local** (`--local`) | Your terminal, impersonating `caelo-provisioner` with your Application Default Credentials. | Everywhere else (laptop, CI) |

With the install job, **closing the terminal does not stop the install** — not Ctrl-C, not a closed Cloud Shell tab, not Cloud Shell's 40-minute idle timeout. Run the installer again (or click the Cloud Shell button again) and pick the same project: it attaches to the running job, shows the result of a finished one, or — if the last run stopped — starts a new run that resumes where that one stopped. `status` shows the same progress.

How it works:

- The job's definition holds no key, password or token. Its only argument is the project; it reads everything else from the install's ops bucket, which only you and `caelo-provisioner` can write.
- It records its progress in `gs://<project>-caelo-ops/install/install-job.json` (which run, which step, why it stopped) next to `progress.json`, where every finished step is checkpointed.
- The Owner setup link is a secret: the job never prints it to its logs. It stores it in the Secret Manager secret `caelo-install-setup-link`, and your terminal reads it from there when the install is done (`gcloud secrets versions access latest --secret=caelo-install-setup-link --project=<project>`) If that secret is deleted later, re-running the installer runs the job once more to store it again.
- `caelo-provisioner` gets three more roles to run the job on its own: `roles/iam.roleAdmin` and `roles/cloudscheduler.admin` for the [IAP sync job](#who-can-open-the-admin-google-iap) (in local mode your own account creates those), and `roles/logging.logWriter` so its log reaches your terminal. It already holds `roles/resourcemanager.projectIamAdmin`, so this widens nothing. Installs in local mode don't get them.
- DNS: with `CLOUDFLARE_API_TOKEN` set in your shell, the installer stores the token in Secret Manager (`caelo-install-cloudflare-token`) and the job reads it from there to set the records itself; delete that secret after the install if you don't want it kept. Without it, the job can't ask you to confirm, so it prints the records (your terminal shows them) and waits up to two hours for them to resolve.
- Cost: one run is about $0.20-0.40 (2 vCPU, 4 GiB, for as long as the install takes); nothing while idle. The job stays in the project after the install, so `status` and a re-run can find it; delete it with `gcloud run jobs delete caelo-install --region=<region>` if you like.
- An install whose Pulumi state is still on your machine (created before [state in the project](#where-the-installs-state-lives)) can't use the job: run `state migrate` first, or `--local`.
- On a laptop, `--install-job` needs [`cosign`](https://docs.sigstore.dev/cosign/system_config/installation/) to verify the release before it starts the job.

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

**Installs created before this change** kept a JSON key at `~/.caelo-<install-id>/secrets/sa-key.json`. The next [`upgrade`](#upgrading) (or installer re-run) removes it, before anything else changes:

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
3. **Target**: after you confirm their cost (< $0.10/mo; `--yes` in scripts), the bucket and KMS key are ensured as for a new install. Migrations and installer runs of one install never overlap: both take the install's state lock (`install/state.lock` in the bucket, `state.lock` in `~/.caelo-<install-id>/` for a local install); a run that finds it held stops and says how to remove a stale one.
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

`bunx @caelo-cms/provisioning@latest --provider gcp --env staging` brings up a parallel staging stack: separate Cloud Run service, separate Cloud SQL instance (or Cloud SQL Smaller-tier — configurable), separate `staging.caelo.example.com` host, `X-Robots-Tag: noindex` header.

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

Installs created before this feature get the job on their next [`upgrade`](#upgrading). The upgrade also removes the operator-access rights an earlier pre-release build gave the admin's own service account. Until you upgrade, an approved user change reports that Google IAP could not be updated.

## Admin on your own domain (`gcp-firebase`)

With `--provider gcp-firebase`, the admin starts out on its Cloud Run URL (`https://caelo-production-admin-….run.app`). To serve it at `admin.<your domain>`:

```bash
bunx @caelo-cms/provisioning@<version> admin-domain enable
```

Google only maps a domain for a verified owner of it. If you have not verified yours yet, the command opens Search Console for you: add the TXT record it shows at your registrar, click **Verify**, then run the command again. It creates the mapping as your own gcloud account and prints the DNS record to add (usually a `CNAME` to `ghs.googlehosted.com.`). Then it waits, with a spinner, until Google has issued the certificate — usually 15-60 minutes once the record resolves — and prints the admin login URL. You can stop it with Ctrl-C at any time: running the command again finds the mapping and resumes waiting. After 60 minutes it stops and prints how to check the status yourself (`dig +short admin.<your domain> CNAME`, `gcloud beta run domain-mappings describe --domain=admin.<your domain> --region=<region> --project=<project>`). Running it again is safe. With more than one install on the machine, pick one with `--install <install-id>`. (`--provider gcp` needs none of this: its load balancer serves `admin.<your domain>` from the start.)

## Protected staging on your own domain (`gcp-firebase`)

Every Stage is served on the staging host behind an access gate — the same artefacts Publish live ships, with only the host swapped (see [Protected staging](/staging-access)). The wizard asks for the host (default `staging.<your domain>`; `--staging-domain <host>` when non-interactive). The gateway serves it; map it once:

```bash
bunx @caelo-cms/provisioning@<version> staging-domain enable
```

It sets the host in the admin for you (no click under Settings → Domains needed), turns on basic-auth password protection the first time and prints the login once (`--rotate-staging-password` for a new one, `--show-staging-password` to see the current one; nothing is written to disk). To move staging to another host, pass `--staging-domain <new host>`; without the flag it maps the host the admin has stored, so a host changed under Settings → Domains is picked up. The host serves pages after the next Stage, and only *published* pages are staged — the command says so and lists draft pages. It works like `admin-domain enable` (same Search Console verification, run as your own gcloud account), opens the gateway's ingress for the domain mapping, and prints the DNS record to add (usually `CNAME staging → ghs.googlehosted.com.`). Like `admin-domain enable`, it then waits for the certificate (Ctrl-C safe, re-run to resume). Running it again is safe. Who may open staging is set in the admin under **Settings → Staging access**.

## Day-2 operations

Every command names a Caelo release in place of `<version>`, such as `0.10.44`: for `upgrade` the release you are moving to, for every other command the release your install runs. Both are shown in the admin under **Settings → Caelo updates**. Without a version, `bunx` keeps running the copy of the CLI it downloaded first, however old.

| Task | How |
|---|---|
| Upgrade to a new release | Copy the command from **Settings → Caelo updates** in the admin — it names the release and this install. By hand: `bunx @caelo-cms/provisioning@<version> upgrade --version <version> --install <domain>` ([see below](#upgrading)) |
| Move an older install's state into its project | `bunx @caelo-cms/provisioning state migrate --install <id or domain>` ([details](#moving-an-existing-installs-state-into-its-project)) |
| Manage the install from another machine | `bunx @caelo-cms/provisioning attach --project <gcp-project-id>` |
| Give someone admin access | Add them at `/settings/users` (or ask the AI) — IAP follows automatically |
| Serve the admin at `admin.<domain>` (gcp-firebase) | `bunx @caelo-cms/provisioning@<version> admin-domain enable` |
| Serve the staging host (gcp-firebase) | `bunx @caelo-cms/provisioning@<version> staging-domain enable` |
| Read logs | Cloud Logging — filter by `resource.labels.service_name="caelo-admin-prod"` |
| Back up the database now | `bunx @caelo-cms/provisioning@<version> backup` — prints the backup id and its restore command (`gcp` and `gcp-firebase`) |
| Restore from PITR | `gcloud sql backups restore` — see [`docs/incident-response.md`](https://github.com/caelo-cms/caelo-cms/blob/main/docs/incident-response.md) §F |
| Rotate the AI provider key | Owner → `/settings/ai` (stored encrypted in the database) |
| Rotate a runtime secret | `bunx @caelo-cms/provisioning@<version> rotate-secret <postgres-password\|public-role-password\|gateway-role-password\|internal-secret\|tool-approval-secret\|staging-gate-secret>` — stores a new value in Secret Manager (for a database password also on its role: `postgres-password` is `admin_role`'s, the other two the gateway's `public_role` and `gateway_role`) and rolls the services that read it |
| Scale Cloud Run | `gcloud run services update caelo-admin-prod --max-instances=20` |

### Upgrading

When a new release is out, the admin's bell shows it, and **Settings → Caelo updates** (`/settings/updates`) shows its release notes and, to an Owner, the exact command for this install with a copy button:

```bash
bunx @caelo-cms/provisioning@0.10.44 upgrade --version 0.10.44 --install caelo.example.com
```

The version is in it twice on purpose: `@0.10.44` runs the CLI of the release you are installing (its upgrade steps match that release), and `--version 0.10.44` rolls exactly that release even if a newer one ships before you run it — without it, `upgrade` rolls whatever is newest. Run it on the machine you installed from (it needs `~/.caelo-<install-id>/`), signed in with `gcloud auth login` as an account that may change the project, with [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) installed (on macOS the command offers to install it). The account must also be able to open the admin, because the health check signs in through Google IAP. It usually takes 5 to 15 minutes.

Before it changes anything, `upgrade` takes a Cloud SQL backup and prints its id; if the backup fails, it stops. After the switch it checks both services; if a check fails, both go back to the version you had and it prints the backup id with the exact `gcloud sql backups restore` command. The database migrations it applied stay, so restore only if the old version no longer works with them (restoring overwrites everything written since the backup). Details in the steps below.

The AI can tell you which version you run and whether an update is out, but it cannot install one.

### Installing an update from the admin

Installs set up or upgraded with this release get an **upgrader**: a Cloud Run job in your project (`caelo-production-upgrader`) that installs Caelo releases from inside Google Cloud, so you no longer need the machine you installed from. On **Settings → Caelo updates** the Owner then sees **Install update** instead of (and the command as an alternative to) the terminal steps:

1. **One-time: Google sign-in for updates.** Before installing, Caelo asks you to sign in to Google again — right then, with your password and second factor. A stolen admin session therefore cannot install anything, and there is no password alternative. The page walks you through creating the Google OAuth client it needs in your project (*APIs & Services → Credentials → OAuth client ID → Web application*, with the redirect URI the page shows) and pasting its ID and secret.
2. **Confirm with Google**, then confirm the install. The page shows what will happen.
3. **Watch the timeline.** The upgrader checks the release's signature, backs up the database (no backup, no change), updates the database, switches the admin and the form service to the new release, tests both, and switches back automatically if a test fails. The timeline survives the admin restarting during the switch, and **Update history** keeps every attempt.

What the upgrader may and may not do: it runs as its own service account with exactly the rights to deploy the two services, run the migration job, back up Cloud SQL and read/write the install's records (`install/` in the `<project>-caelo-ops` bucket). It cannot change IAM, service accounts, secrets or anything else in the project, and the admin can only start it — not change what it runs. It installs only releases signed by Caelo's release workflow that are newer than the one you run.

**Releases that change your cloud setup** (new permissions, a new service) cannot be installed this way, because the admin's upgrader is not allowed to change them. The page then explains why and gives a **Open Cloud Shell** link plus the commands to paste there — Cloud Shell is a free terminal in your browser, already signed in as you:

```bash
curl -fsSL https://bun.sh/install | bash && export PATH="$HOME/.bun/bin:$PATH"
bunx @caelo-cms/provisioning@<version> attach --project <gcp-project-id>
bunx @caelo-cms/provisioning@<version> upgrade --version <version> --install <domain>
```

To get the upgrader on an existing install, run `upgrade` once as described above (its state must live in the project: `state migrate` first if it still lives on your machine).

### Automatic updates

Below the install section, **Automatic updates** lets the Owner choose what installs without a click. Every change — saving the settings, pausing, resuming — is confirmed with its own fresh Google sign-in, like installing.

| Setting | Default | What it means |
|---|---|---|
| When a new release comes out | *Tell me; I install it myself* | *Don't tell me* / *Tell me* / *Install the kinds I choose automatically* |
| Security fixes | off | Releases whose signed release information names a **published GitHub Security Advisory**. A release only counts as a security fix with one: the release workflow refuses the flag without it, and the upgrader checks it again against the signed manifest. |
| Patch releases | off | Bug-fix releases (`0.10.47 → 0.10.48`). |
| Minor releases | off | Feature releases (`0.10 → 0.11`). |
| Maintenance window | any time | Only start an automatic install between two times in your time zone (a window like `22:00–04:00` spans midnight). |
| Wait after a release | 24 hours | A release becomes installable this long after it was published, so problems others hit surface first. |
| Wait for security fixes | 2 hours | The same for security fixes: shorter, because the problem they fix is public, but long enough for a broken release to be pulled. `0` installs at once; it can never be longer than the normal wait. |

Never installed automatically, whatever you choose — you get an email instead:

- **major releases** (before Caelo 1.0);
- releases that **change your cloud setup** — they need Cloud Shell, see above;
- releases with **destructive database changes** — you install them from the page;
- releases that are not on the stable channel.

**How it runs.** The admin checks every 15 minutes (one admin instance decides per check, however many are running). When a release is allowed, past its waiting time and inside the window, it queues the same request **Install update** writes — marked *automatic* in the history — and starts the upgrader. The upgrader verifies the signed release information and the policy again before it changes anything. Each release is tried automatically once; if that attempt is refused or fails, it is not retried on its own.

**Pause.** *Pause* stops automatic installs for 1 day to 30 days, or until you resume them. A failed or rolled-back automatic install pauses them too, until you have looked at it and clicked *Resume*.

**Emails.** The Owner (everyone holding the *platform.update* permission) gets an email when a release is available, when one is scheduled to install automatically, when it was installed, when an automatic install did not complete, and when a release needs Cloud Shell. They go through the email service set up at **Settings → Email**; without one, the page lists them as *Not sent: no email set up*. The emails name the page (`/settings/updates`) rather than link it.

The AI can explain the policy and what the scheduler last decided (`get_caelo_update_policy`, `get_caelo_auto_update_status`), but it cannot change either or install anything.

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

**Several installs on one machine.** `upgrade`, `status`, `backup`, `rotate-secret`, `truncate` and `destroy` never guess which install you mean. With more than one install under `~/.caelo-*`, they ask in the terminal which one to act on; `upgrade`, `status` and `backup` also offer "All installs", which runs them one after another and stops at the first that fails. In scripts, name the install with `--install <install-id or domain>`, for example `bunx @caelo-cms/provisioning@0.10.44 upgrade --version 0.10.44 --install example.com`, or `--install all`.

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

Installers before this change stored the database URLs, with `admin_role`'s and `public_role`'s passwords, and the Owner setup link in `progress.json`. The next `upgrade` (or installer re-run) removes them from the file, keeps every finished step, and tells you which password to rotate, with the exact command, for example `bunx @caelo-cms/provisioning@0.10.44 rotate-secret postgres-password --install example.com`. Run the commands it prints: copies of the old file may sit in backups or synced folders. The setup link needs no rotation; it expires after 24 hours and stops working once the Owner account exists.

## Common issues

- **TLS cert stuck on `provisioning`** — DNS hasn't propagated. `dig +short admin.caelo.example.com` should return the load balancer IP (`gcp`) or `ghs.googlehosted.com.` (`gcp-firebase` admin mapping). Wait 15-60 min; Google-managed certs poll for a valid challenge. The main domain's certificate on `gcp` only validates after its go-live records point at the load balancer.
- **`Constraint constraints/gcp.resourceLocations violated … in [global]`** — your organization only allows certain locations. New installs keep every secret in the install region, so this does not occur there. Installs created before that keep their existing automatic-replication secrets; when the installer or `upgrade` adds a secret and the policy refuses automatic replication, it creates that secret in the install region instead and says so in its output.
- **Site shows Firebase's "Site Not Found" although DNS is correct (`gcp-firebase`)** — when the custom domain was created while DNS still pointed at the old host, Firebase can stop re-checking it and leave it at `HOST_MISMATCH` / `OWNERSHIP_PENDING`. The Domains page (`/settings/domains`) and the AI's `list_domains` mark such a domain **stuck — reconnect recommended**: click **Reconnect** there, or let the AI propose it and approve in the chat. Caelo deletes and re-creates the custom domain (it is not serving yet, so nothing goes offline), and once it is active re-releases the live version so Firebase's CDN drops the cached 404.
- **`Cannot allocate memory` from Cloud SQL** — bump tier from `db-g1-small` to `db-custom-2-7680` via `gcloud sql instances patch`.
- **A new user gets "You don't have access" from Google** — the approval result says why. Most often their email is not a Google account, or the install predates operator access: run [`upgrade`](#upgrading) once, then click **Re-sync Google IAP access** at `/settings/users`.
- **Stage fails with "the stored files of … media asset(s) are missing"** — the install ran a release that kept media on the admin container's own disk, which Cloud Run discards on every new revision and scale-to-zero. Run [`upgrade`](#upgrading): it mounts the media bucket into the admin (execution environment gen2, a Cloud Storage volume named `media` of the `<project>-caelo-production-media` bucket at `/app/apps/admin/data/media`). If you already added exactly that volume by hand, upgrade keeps it. Files lost before the upgrade cannot be recovered from Cloud Run; ask the AI to "fix the missing media" — it lists them (`list_missing_media`), re-imports what came from a URL, and tells you which files to re-upload at `/content/media` (re-uploading the same file restores it on every page that uses it).
- **The admin refuses to start: "media storage is not durable"** — the admin found no persistent volume at its media root. Run [`upgrade`](#upgrading), which adds it.
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
- **Cloud Shell asks "Trust repo?" / opens a temporary session** — expected: `caelo-cms/install` is not a Google repository, so Cloud Shell never gives it your credentials automatically. Answer either way and sign in with `gcloud auth login --update-adc` (the tutorial's first step).
- **`run.sh`: "This Cloud Shell has no access to your Google account yet"** — it runs `gcloud auth login --update-adc` for you: open the link it prints, sign in with the account that owns (or will own) the project, paste the code. If you signed in with the wrong account, `gcloud auth login` again with the right one and re-run.
- **The Cloud Shell tab closed, timed out (40 minutes idle) or you pressed Ctrl-C** — the install keeps running. Click the button again, sign in, run `./run.sh` with the same project id: it attaches to the running install or shows the finished result.
- **The button says the branch `release-v<version>` does not exist** — the release was published less than about 30 minutes ago and `caelo-cms/install` hasn't pinned it yet; try again shortly. Or use the previous release's link from the [releases page](https://github.com/caelo-cms/caelo-cms/releases).
- **`run.sh`: "checksum mismatch … refusing to run it"** or **`npm audit signatures` fails** — a download or a package isn't what the release pinned. Nothing was run. Re-run once (a truncated download); if it persists, do not proceed and open an issue with the output.
- **`run.sh`: "… predates the Cloud Shell install"** — that release's provisioner has no install job; use a newer release's link, or install from a terminal with `bunx @caelo-cms/provisioning@<version>`.
- **Cloud Shell says your weekly quota is used up** — Cloud Shell allows 50 hours a week. The install job doesn't count against it (it runs in your project); you only need Cloud Shell again to follow it or to see the setup link (also readable with `gcloud secrets versions access latest --secret=caelo-install-setup-link --project=<project>` from any machine).
- **"The install job failed: …"** — the message is the job's last output; the full log is under Cloud Run → Jobs → `caelo-install` in the console (or `gcloud run jobs executions list --job=caelo-install --region=<region>`). Fix the cause and run the installer again for the same project: the new run resumes at the step that failed. A run that ended without a result ("ended (failed) without recording a result") was stopped from outside — out of memory, its 6-hour limit, or cancelled; re-running resumes too.
- **The install job stops at "Waiting for DNS"** — it waits up to two hours for the records it printed to resolve. Set them at your registrar and run the installer again; it resumes at the DNS step.
- **"Could not verify release v…" before the install job starts** — the installer checks the release's signed manifest with `cosign` before it pins the job's image. Install `cosign` (Cloud Shell: the install script does it), check the machine can reach `europe-west1-docker.pkg.dev`, and re-run. A signature error means the release on the registry is not the one Caelo's release workflow signed: do not proceed, open an issue.
- **"This install's Pulumi state is on this machine … the install job can't run it"** — move the state into the project with `state migrate`, or re-run with `--local`.
- **Pulumi says it can't decrypt (`incorrect passphrase`, KMS permission denied)** — for an install in its project, check `gcloud auth application-default login` uses an account with access to the key; for a local install, `secrets/pulumi-passphrase` must be the original file (restore it from `~/.caelo-backups/`).

## Next

- [AWS install →](/install-aws)
- [Architecture →](/architecture)
- Incident response: [`docs/incident-response.md`](https://github.com/caelo-cms/caelo-cms/blob/main/docs/incident-response.md)
