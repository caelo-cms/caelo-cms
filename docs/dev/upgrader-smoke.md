<!-- SPDX-License-Identifier: MPL-2.0 -->

# Real-GCP upgrader smoke test

Issue #818. Every Caelo release is installed on a dedicated, throwaway
Caelo install in its own Google Cloud project by that install's **own
upgrader job** — started exactly the way every install starts it:
**Settings → Updates, one click + the Owner's password**. A release tag
cannot ship while the smoke install does not cleanly serve the release
before it.

Why it exists: the first live in-app update (2026-10-16) died at its first
bucket write on an IAM condition that can never match (#799), and the
v0.10.51 gateway exited on start only on Cloud Run (#821). Unit tests
against a fake gcloud cannot catch either class of bug (CLAUDE.md §4,
§6). The smoke install runs the real thing: the upgrader job's image and
service account, its IAM self-check, the Cloud SQL backup, the migration
job on Direct VPC egress, the roll, the deep health check through IAP, and
the self-update.

## The decision: no side channel

An earlier draft of #818 added an operator endpoint
(`POST /api/internal/platform-update`) and a `cms-provision
request-update` command so CI could queue an update by itself. That was
removed before merge. The maintainer decision: **every release installs
via Settings → Updates with one click + password; there is no other way
to start an update**, not even for CI. A second path would be a second
attack surface and would test something other than what Owners use.

So the smoke test never starts an update. It is split in two:

| | When | What it checks |
|---|---|---|
| **gate** | `release.yml`, for every tag, after the images and the signed manifest are published and **before** npm and the GitHub Release | the candidate's signed manifest verifies, **and** the smoke install cleanly serves the release it runs, which must be at least the previous stable release N-1. A tag is not offered in Settings → Updates before it is published, so the gate cannot install it — it proves that N-1 went through the real in-app path. |
| **verify** | by hand (Actions → `upgrader-smoke` → Run workflow, mode `verify`), after the maintainer installed the published release on the smoke install through Settings → Updates | the smoke install runs exactly that release and serves it cleanly. |

"Cleanly serves release R", checked from outside with read-only access:

- `install.json` in the ops bucket records R and the signed manifest's
  admin + gateway digests;
- the revisions serving traffic run exactly those images, and both
  services are `Ready` (the images booted on Cloud Run);
- the upgrader job runs R's ops image (its self-update, the last step of
  an in-app update).

The trade-off, stated plainly: a release's own upgrader run happens
after it is published, not before. What blocks is the chain — release
N+1 cannot ship until release N was installed through Settings → Updates
on the smoke install and serves cleanly. Release candidates are not
offered in Settings → Updates (it follows the newest stable release), so
the chain runs over stable releases; an RC tag's gate checks the smoke
install on N-1.

### After every stable release

1. Open the smoke install's admin → Settings → Updates → **Install
   update**, confirm with the Owner's password.
2. Wait for it to end (the timeline on the same page).
3. Actions → `upgrader-smoke` → Run workflow, candidate = the release,
   mode = `verify`.

If step 3 fails, the next release tag fails its gate too — fix the
upgrader first ("When it fails" below).

The repository variable `UPGRADER_SMOKE` decides whether the gate runs:
`required` (run, block on failure) or `off` (releases ship with a
warning). Any other value — including unset — fails the release, so
skipping it is always a visible, deliberate choice. **Set it (at least to
`off`) before the next release tag.** The decision runs in its own job
with no token and outside the `upgrader-smoke` environment, so an `off`
release never waits for an environment reviewer and never touches GCP;
only the check itself runs in the environment and may mint an OIDC token
(`scripts/upgrader-smoke-workflow.test.ts` pins this).

## One-time setup (maintainer)

Do this once, as the maintainer, with your own gcloud identity. Nothing
here creates a long-lived key (CLAUDE.md §11.C): GitHub Actions gets a
short-lived token through Workload Identity Federation, and the identity
it gets can only read.

### 1. The smoke install

Create a fresh project and install Caelo there with the normal
one-command flow, at the newest stable release, on a domain you control
but nobody uses, e.g. `upgrader-smoke.<your-domain>`. You are its Owner;
use a password only for this install (it is the one that confirms each
update).

```sh
bunx @caelo-cms/provisioning --provider gcp-firebase \
  --domain upgrader-smoke.example.com --owner-email you@example.com \
  --project-id caelo-upgrader-smoke --region europe-west1
```

The install must keep its state in its own project (the default for the
Cloud Shell install job; otherwise run `cms-provision state migrate`).

Cost: the install's normal idle cost (the installer prints the table;
Cloud SQL `db-f1-micro`, scale-to-zero Cloud Run, Firebase Hosting).

### 2. The CI service account and its grants

Read-only, on the smoke project only. It needs no secret, no token
creator role, and no Service Usage role:

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
```

### 3. Workload Identity Federation and the protected environment

Create a GitHub environment named **`upgrader-smoke`** (Settings →
Environments) and protect it: deployment branches and tags limited to
`main` and tags matching `v*`. Optionally add yourself as a required
reviewer for manual runs. The workflow's job runs in that environment.

Then trust only this repository's `upgrader-smoke.yml`, on `main` or a
release tag, in that environment:

```sh
gcloud iam workload-identity-pools create github --project=$P \
  --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc caelo-cms --project=$P \
  --location=global --workload-identity-pool=github \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.job_workflow_ref=assertion.job_workflow_ref,attribute.ref=assertion.ref,attribute.environment=assertion.environment" \
  --attribute-condition="assertion.repository == 'caelo-cms/caelo-cms' && assertion.job_workflow_ref.startsWith('caelo-cms/caelo-cms/.github/workflows/upgrader-smoke.yml@') && (assertion.ref == 'refs/heads/main' || assertion.ref.startsWith('refs/tags/v')) && assertion.environment == 'upgrader-smoke'"

N=$(gcloud projects describe $P --format='value(projectNumber)')
gcloud iam service-accounts add-iam-policy-binding $SA --project=$P \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$N/locations/global/workloadIdentityPools/github/attribute.repository/caelo-cms/caelo-cms"
```

Why each clause: `job_workflow_ref` pins the workflow file (as a reusable
workflow called by `release.yml` it still names `upgrader-smoke.yml`);
`ref` keeps a branch or a pull request from minting a token;
`environment` makes the GitHub-side protection rules part of the trust.

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
smoke install runs, mode `verify`. Without any cloud access, the planning
half runs locally:

```sh
bun scripts/upgrader-smoke.ts --candidate 0.11.0 --mode gate --installed 0.10.53
```

## Reset

When the smoke install is ahead of a candidate (an RC was cut, then
abandoned for a different line), an upgrader cannot go back. The install
is throwaway: delete the project and redo step 1 at the previous stable
release (steps 2–4 are per project, so redo them too, or reuse a new
project id in the variables).

## When it fails

The update's full timeline is on the smoke install's Settings → Updates
page. The usual suspects:

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
- The gate says the previous release "never went through the real in-app
  update": install it on the smoke install via Settings → Updates, run
  mode `verify`, then re-run the release workflow.
