<!-- SPDX-License-Identifier: MPL-2.0 -->

# Real-GCP upgrader smoke test

Issue #818. Every release tag is installed on a dedicated, throwaway
Caelo install in its own Google Cloud project by that install's **own
upgrader job**, before npm and the GitHub Release go out. A failure
blocks the release.

Why it exists: the first live in-app update (2026-10-16) died at its first
bucket write on an IAM condition that can never match (#799), and the
v0.10.51 gateway exited on start only on Cloud Run (#821). Unit tests
against a fake gcloud cannot catch either class of bug (CLAUDE.md §4,
§6). This test runs the real thing: the upgrader job's image and service
account, its IAM self-check, the Cloud SQL backup, the migration job on
Direct VPC egress, the roll, the deep health check through IAP, and the
self-update.

## What a run does

`.github/workflows/upgrader-smoke.yml` runs `scripts/upgrader-smoke.ts`:

1. Verifies the candidate's signed release manifest (cosign, the same
   check every upgrader makes).
2. Reads the smoke install's `install.json` from its ops bucket and plans:
   - install at the previous stable release N-1: test N-1 → candidate;
   - install behind N-1: install N-1 first, then the candidate;
   - install at an earlier candidate of the same cycle: test that →
     candidate (the release train: every tag, RC and stable, is
     installed in order, so the first RC of a cycle is always tested from
     N-1);
   - install already at the candidate: only re-check (an idempotent
     re-run);
   - install ahead of the candidate: fail and point here ("Reset").
3. Runs `cms-provision request-update --version <v> --wait` for each step.
   That goes through the admin's IAP as `caelo-mcp`, with the install's
   internal secret, to `POST /api/internal/platform-update`, which queues
   the request and starts the upgrader job exactly like the Owner's
   "Install update"; the command follows the timeline and fails unless the
   request ends `succeeded`.
4. Checks from outside: `install.json` records the candidate and the
   manifest's admin + gateway digests; the revisions serving traffic run
   those images; both services are `Ready`; the upgrader job runs the
   candidate's ops image.

The repository variable `UPGRADER_SMOKE` decides whether it runs:
`required` (run, block on failure) or `off` (releases ship with a
warning). Any other value — including unset — fails the release, so
skipping it is always a visible, deliberate choice.

## One-time setup (maintainer)

Do this once, as the maintainer, with your own gcloud identity. Nothing
here creates a long-lived key (CLAUDE.md §11.C): GitHub Actions gets a
short-lived token through Workload Identity Federation.

### 1. The smoke install

Create a fresh project and install Caelo there with the normal
one-command flow, as **`gcp-firebase`** (`request-update` reaches the
admin through its `run.app` URL, like `owner-reset`; plain `gcp` follows
with #770). Use the newest stable release and a domain you control but
nobody uses, e.g. `upgrader-smoke.<your-domain>`.

```sh
bunx @caelo-cms/provisioning --provider gcp-firebase \
  --domain upgrader-smoke.example.com --owner-email you@example.com \
  --project-id caelo-upgrader-smoke --region europe-west1
```

The install must keep its state in its own project (the default for the
Cloud Shell install job; otherwise run `cms-provision state migrate`),
and its admin must already have `/api/internal/platform-update`, i.e. run
a release that contains #818. Until a stable release with #818 is
installed there, keep `UPGRADER_SMOKE=off`.

Cost: the install's normal idle cost (the installer prints the table;
Cloud SQL `db-f1-micro`, scale-to-zero Cloud Run, Firebase Hosting).

### 2. The CI service account and its grants

Least privilege, all on the smoke project only:

```sh
P=caelo-upgrader-smoke
SA=caelo-smoke-ci@$P.iam.gserviceaccount.com
gcloud iam service-accounts create caelo-smoke-ci --project=$P \
  --display-name="Caelo upgrader smoke test (GitHub Actions)"

# Read install.json in the ops bucket.
gcloud storage buckets add-iam-policy-binding gs://$P-caelo-ops \
  --member=serviceAccount:$SA --role=roles/storage.objectViewer
# Read services, revisions and the upgrader job.
gcloud projects add-iam-policy-binding $P \
  --member=serviceAccount:$SA --role=roles/run.viewer --condition=None
# The internal secret, and nothing else in Secret Manager.
gcloud secrets add-iam-policy-binding caelo-production-internal-secret --project=$P \
  --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
# Sign the IAP credential as caelo-mcp (the admin's IAP admits it).
gcloud iam service-accounts add-iam-policy-binding caelo-mcp@$P.iam.gserviceaccount.com \
  --project=$P --member=serviceAccount:$SA \
  --role=roles/iam.serviceAccountTokenCreator
# `request-update` re-enables iamcredentials.googleapis.com (a no-op when
# on), which needs serviceusage.services.enable.
gcloud projects add-iam-policy-binding $P \
  --member=serviceAccount:$SA --role=roles/serviceusage.serviceUsageAdmin --condition=None
```

### 3. Workload Identity Federation

Trust only this repository's `upgrader-smoke.yml` (as a reusable workflow
called by `release.yml`, `job_workflow_ref` names `upgrader-smoke.yml`):

```sh
gcloud iam workload-identity-pools create github --project=$P \
  --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc caelo-cms --project=$P \
  --location=global --workload-identity-pool=github \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.job_workflow_ref=assertion.job_workflow_ref" \
  --attribute-condition="assertion.repository == 'caelo-cms/caelo-cms' && assertion.job_workflow_ref.startsWith('caelo-cms/caelo-cms/.github/workflows/upgrader-smoke.yml@')"

N=$(gcloud projects describe $P --format='value(projectNumber)')
gcloud iam service-accounts add-iam-policy-binding $SA --project=$P \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$N/locations/global/workloadIdentityPools/github/attribute.repository/caelo-cms/caelo-cms"
```

### 4. Repository variables

Settings → Secrets and variables → Actions → Variables (no secrets
needed):

| Variable | Value |
|---|---|
| `UPGRADER_SMOKE` | `required` (or `off`, see above) |
| `UPGRADER_SMOKE_PROJECT` | `caelo-upgrader-smoke` |
| `UPGRADER_SMOKE_REGION` | `europe-west1` |
| `UPGRADER_SMOKE_WIF_PROVIDER` | `projects/<N>/locations/global/workloadIdentityPools/github/providers/caelo-cms` |
| `UPGRADER_SMOKE_SA_EMAIL` | `caelo-smoke-ci@caelo-upgrader-smoke.iam.gserviceaccount.com` |

### 5. Check it

Actions → `upgrader-smoke` → Run workflow, candidate = the release the
smoke install runs, `dry_run` on. It authenticates, verifies the
manifest, reads `install.json` and prints the plan without requesting
anything. Without any cloud access, the planning half runs locally:

```sh
bun scripts/upgrader-smoke.ts --candidate 0.11.0-rc.1 --installed 0.10.53
```

## Reset

When the smoke install is ahead of a candidate (an RC was cut, then
abandoned for a different line), an upgrader cannot go back. The install
is throwaway: delete the project and redo step 1 at the previous stable
release (steps 2–4 are per project, so redo them too, or reuse a new
project id in the variables).

## When it fails

The workflow log carries the update's full timeline (every line the
admin shows under Settings → Updates). The usual suspects:

- `iam-preflight`: the upgrader's own IAM self-check
  (`packages/provisioning/src/upgrader-iam-preflight.ts`) found missing
  permissions and named each of them. Fix the grant in
  `upgrader-setup.ts`; a Cloud Shell `cms-provision upgrade` on the smoke
  install re-converges it.
- Migration job errors mentioning `compute.subnetworks` would mean Direct
  VPC egress needs more than Google documents (only the Cloud Run service
  agent needs compute permissions); see the note in `upgrader-setup.ts`.
- A service not `Ready`, or a rolled-back request: the new image did not
  boot on Cloud Run — the class of #821.
