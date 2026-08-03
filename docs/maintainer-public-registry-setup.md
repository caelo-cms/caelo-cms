# Maintainer one-time setup — public image registry mirrors

The release-images workflow publishes `admin` + `gateway` containers to:
1. `ghcr.io/caelo-cms/<service>` — canonical, used by Compose installs.
2. `<region>-docker.pkg.dev/<project>/caelo-cms-images/<service>` — required because Cloud Run rejects ghcr.io directly.
3. *(P15)* `public.ecr.aws/caelo-cms/<service>` — for AWS adapter.
4. *(P15)* `<acr>.azurecr.io/<service>` — for Azure adapter.

This doc is the one-time, maintainer-only setup for the GCP mirror so OSS operators get zero-friction deploys (no operator-side AR repos, no per-install copy step).

## Prerequisites

- A GCP project the Caelo team controls (we currently use `caelo-website`; a dedicated `caelo-cms-public-registry` is the long-term home).
- Owner permission on the GitHub org `caelo-cms`.
- gcloud authed as a project owner.

## One-time setup

```bash
PROJECT=caelo-website
REGION=europe-west1
REPO=caelo-cms-images
WIF_POOL=github-actions
WIF_PROVIDER=github-caelo-cms
SA_NAME=caelo-cms-image-publisher
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
GH_REPO=caelo-cms/caelo-cms

# 1. Enable APIs (no-op if already enabled).
gcloud services enable artifactregistry.googleapis.com iamcredentials.googleapis.com --project="${PROJECT}"

# 2. Create the public AR repo.
gcloud artifacts repositories create "${REPO}" \
  --location="${REGION}" \
  --repository-format=docker \
  --project="${PROJECT}" \
  --description="Caelo CMS — public image mirror (anonymous pull)"

# 3. Make it anonymous-readable. allUsers gets reader; pulls need no auth.
gcloud artifacts repositories add-iam-policy-binding "${REPO}" \
  --location="${REGION}" \
  --project="${PROJECT}" \
  --member="allUsers" \
  --role="roles/artifactregistry.reader"

# 4. Create the publish service account.
gcloud iam service-accounts create "${SA_NAME}" \
  --display-name="Caelo CMS image publisher (GitHub Actions)" \
  --project="${PROJECT}"

# 5. Grant push on just this repo.
gcloud artifacts repositories add-iam-policy-binding "${REPO}" \
  --location="${REGION}" \
  --project="${PROJECT}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/artifactregistry.writer"

# 6. Workload Identity Federation pool + GitHub provider.
gcloud iam workload-identity-pools create "${WIF_POOL}" \
  --location=global \
  --display-name="GitHub Actions" \
  --project="${PROJECT}"

gcloud iam workload-identity-pools providers create-oidc "${WIF_PROVIDER}" \
  --location=global \
  --workload-identity-pool="${WIF_POOL}" \
  --display-name="GitHub caelo-cms" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository == '${GH_REPO}'" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --project="${PROJECT}"

# 7. Allow the GitHub repo to impersonate the publisher SA.
PROJECT_NUMBER=$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')
WIF_PROVIDER_RESOURCE="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/providers/${WIF_PROVIDER}"
WIF_PRINCIPAL="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/attribute.repository/${GH_REPO}"

gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --project="${PROJECT}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="${WIF_PRINCIPAL}"

# 8. Print the values to set as GitHub Actions repo variables.
echo
echo "Set these GitHub Actions VARIABLES (Settings → Secrets and variables → Actions → Variables):"
echo
echo "  GCP_PUBLIC_REGISTRY_WIF_PROVIDER=${WIF_PROVIDER_RESOURCE}"
echo "  GCP_PUBLIC_REGISTRY_SA_EMAIL=${SA_EMAIL}"
echo "  GCP_PUBLIC_REGISTRY_PROJECT=${PROJECT}"
echo "  GCP_PUBLIC_REGISTRY_REGION=${REGION}"
echo "  GCP_PUBLIC_REGISTRY_REPO=${REPO}"
```

## Verification

After landing the variables in GitHub Actions, push an empty commit to trigger release-images:

```bash
git commit --allow-empty -m "chore: trigger release-images for AR mirror"
git push origin main
```

Watch `gh run watch` — the workflow's "Mirror image to GCP public AR" step should succeed for both admin + gateway. Then anonymous pull should work:

```bash
gcloud artifacts docker images list europe-west1-docker.pkg.dev/caelo-website/caelo-cms-images
docker pull europe-west1-docker.pkg.dev/caelo-website/caelo-cms-images/admin:main  # no auth
```

## Retention — releases live forever, dev images for 7 days

release-images publishes two kinds of images per service, with different lifetimes:

| Kind | Tags | Lifetime | Why |
|---|---|---|---|
| Release images | `X.Y.Z`, `X.Y`, `latest` | forever | The artifacts operators pin. `cms-provision upgrade` defaults to `latest`; the live caelo-cms.com deploy runs a release digest. Deleting one would break `--version vX.Y.Z` pins + cosign verification. |
| Dev images | `main` (floating), `main-<sha7>` (per merge) | 7 days | Debug/bisect material only. Nothing references them after a few days — the wizard resolves the floating `main` tag, never a `main-<sha7>`. |

Deleting an old digest cannot break a deployed install: per the Cloud Run docs, *"The container image is imported by Cloud Run when deployed. Cloud Run keeps this copy of the container image as long as it is used by a serving revision."* Only re-deploying that exact digest would need the registry copy — and both retention rules below always keep the newest dev images, so the floating `main` tag stays resolvable.

Enforcement is per registry:

- **GHCR** — the scheduled [`registry-retention.yml`](../.github/workflows/registry-retention.yml) workflow prunes `main-<sha7>` images older than 7 days plus orphaned untagged manifests, daily. Manual `workflow_dispatch` runs default to dry-run.
- **GCP AR mirror** — native [cleanup policies](https://cloud.google.com/artifact-registry/docs/repositories/cleanup-policy) do the same server-side (no credentials, no cron to maintain). One-time apply (policy file lives at [`maintainer-ar-cleanup-policy.json`](./maintainer-ar-cleanup-policy.json)):

```bash
gcloud artifacts repositories set-cleanup-policies caelo-cms-images \
  --location=europe-west1 \
  --project=caelo-website \
  --policy=docs/maintainer-ar-cleanup-policy.json \
  --no-dry-run
```

The policy deletes `main-*`-tagged versions older than 7 days and untagged versions older than 7 days, with a keep-rule for the 10 most recent versions per package as an idle-week backstop (keep beats delete in AR policy evaluation, and release tags never match the `main-` prefix). AR runs cleanup policies roughly daily; expect up to a day of lag after applying.

Known cosmetic leftover: cosign signature artifacts (`sha256-<digest>.sig` tags) of deleted dev images stay behind as orphaned versions in AR — they can't be prefix-matched without also matching release signatures, and at ~2 KB each they're not worth a bespoke GC. GHCR-side the cleanup action removes them together with their subject image.

## Operator deploy after mirror is live

Operators run `bunx @caelo-cms/provisioning --provider gcp` and Cloud Run pulls from the mirror — no operator-side AR repo, no copy step, no auth. To pin a specific tag, operators do `pulumi config set caelo-gcp:image-tag v0.1.2`.

To repoint at a different mirror project (e.g. when the dedicated `caelo-cms-public-registry` project is set up later):

```bash
pulumi config set caelo-gcp:public-registry-project caelo-cms-public-registry
pulumi config set caelo-gcp:public-registry-region us-central1   # if not europe-west1
```
