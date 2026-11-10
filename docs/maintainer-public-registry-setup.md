# Maintainer one-time setup — public image registry mirrors

The release-images workflow publishes the `admin`, `gateway`, `mcp-auth-proxy` and `ops` containers (and release.yml the signed `release-manifest` artifact, epic #696) to:
1. `ghcr.io/caelo-cms/<service>` — canonical, used by Compose installs. Every publishing build: main and every release.
2. `<region>-docker.pkg.dev/<project>/caelo-cms-images/<service>` — required because Cloud Run rejects ghcr.io directly. Releases and release candidates only (#1558); a push to main never reaches it.
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

The mirror receives release builds only (#1558), so a push to main does not exercise it. After landing the variables in GitHub Actions, cut a release candidate (RELEASING.md, "Pre-releases"): its `release.yml` run calls release-images on the tag.

Watch `gh run watch` — release-images' "Mirror image (+ signatures) to GCP public AR" and "Verify the mirrored image is signed (gate)" steps should succeed for every image (admin, gateway, mcp-auth-proxy, ops). A new GHCR package (such as `mcp-auth-proxy` on its first push, #1328) starts private: set its visibility to public and link it to the repo under the package's settings, or anonymous Compose pulls and the retention workflow fail for it. Then anonymous pull should work:

```bash
gcloud artifacts docker images list europe-west1-docker.pkg.dev/caelo-website/caelo-cms-images
docker pull europe-west1-docker.pkg.dev/caelo-website/caelo-cms-images/admin:<rc-version>  # no auth
```

## Signatures must survive the mirror

`cms-provision upgrade` cosign-verifies every image digest it is about to roll, against the AR mirror — so an AR copy without its signature is an unrollable release, even when GHCR's copy is signed fine.

The mirror step therefore uses `oras copy -r`, which walks the OCI referrer graph. Do NOT go back to `cosign copy`: cosign 3.x attaches signatures as OCI referrers instead of the legacy `<digest>.sig` tag, and `cosign copy` (deprecated in 3.x) only moves the legacy scheme — it exits 0 and leaves the mirror unsigned. That is how v0.10.23 and v0.10.24 shipped unverifiable mirror images. The `Verify the mirrored image is signed` step in `release-images.yml` now runs the operator's exact check inside CI so the failure surfaces at release time, not days later on someone's upgrade.

To repair an already-published release whose mirror is unsigned, re-run `release-images` against the tag (`gh workflow run release-images.yml --ref vX.Y.Z`): it re-signs and re-mirrors under the same semver tags.

## Retention — releases forever, release candidates 14 days, dev images 7 days on GHCR only

release-images publishes three kinds of images per service (#1558):

| Kind | Tags | GHCR | GCP AR mirror | Why |
|---|---|---|---|---|
| Release | `X.Y.Z`, `X.Y`, `latest` | forever | forever | What installs run. Fresh installs resolve `latest` or the release `--version` names; `cms-provision upgrade` the same. |
| Release candidate | `X.Y.Z-rc.N` and the marker `rc-X.Y.Z-rc.N` (no `X.Y`, no `latest`) | forever | 14 days | For scratch installs before a release goes out (RELEASING.md, "Pre-releases"). Self-hosted test installs pull from GHCR, which keeps it. |
| Dev image | `main` (floating), `main-<sha7>` (per merge) | 7 days | never published | Debug/bisect material only — compose dev setups and manual pulls. Nothing in the install path references them. |

A release stays in the mirror for good. Cloud Run imports a service's image when it deploys it and serves from that copy — per the Cloud Run docs, *"The container image is imported by Cloud Run when deployed. Cloud Run keeps this copy of the container image as long as it is used by a serving revision."* Cloud Run **jobs** do not: they pull their image each time they run, and a deleted image fails the execution with "Image not found". An install's jobs run its own release's images — the upgrader's first stage and the converge job the installed release's ops image, the quality audit and page captures its admin image — so a deleted release would cost every install still on it its updates from Settings → Updates, its converge job, its quality audits and its page captures, and an update's rollback could not redeploy it. Deleting old releases becomes possible once installs keep their own copy of the images they run.

A release candidate loses exactly that after 14 days. That is why it is for test installs only, and why `init --version` and `upgrade --version` (or `--channel rc`) on Google Cloud warn and ask before they install one (`--accept-release-candidate` confirms in a script).

Enforcement is per registry:

- **GHCR** — the scheduled [`registry-retention.yml`](../.github/workflows/registry-retention.yml) workflow prunes `main-<sha7>` images older than 7 days plus orphaned untagged manifests, daily. Manual `workflow_dispatch` runs default to dry-run.
- **GCP AR mirror** — native [cleanup policies](https://cloud.google.com/artifact-registry/docs/repositories/cleanup-policy) server-side (no credentials, no cron to maintain). One-time apply, and again after every change to the policy file [`maintainer-ar-cleanup-policy.json`](./maintainer-ar-cleanup-policy.json):

```bash
gcloud artifacts repositories set-cleanup-policies caelo-cms-images \
  --location=europe-west1 \
  --project=caelo-website \
  --policy=docs/maintainer-ar-cleanup-policy.json \
  --no-dry-run
```

The rules:

- `delete-release-candidates-after-14d` — versions tagged `rc-*` older than 14 days. A release candidate's images and its release manifest carry the marker `rc-<version>` (release-images.yml, release.yml). A tag-prefix rule matches a version when one of its tags starts with the prefix (AR: *"Applied on any prefix match"*), so the candidate goes although it also carries `X.Y.Z-rc.N`. No release tag starts with `rc-` or `main-`; `scripts/ar-cleanup-policy.test.ts` pins that no delete rule matches a release.
- `delete-untagged-after-7d` — untagged versions older than 7 days. AR never deletes an image a parent manifest still references, and attachments (cosign signatures as OCI referrers) are deleted with their image, not on their own.
- `delete-main-dev-images-after-7d` — the `main-*` dev images pushed before #1558. Nothing pushes them any more; the rule clears the last of them and then matches nothing.
- `keep-10-most-recent-versions` — keep beats delete in AR policy evaluation, so in an idle stretch a release candidate that is still among the 10 most recent versions of its package outlives its 14 days.

AR runs cleanup policies roughly daily; expect up to a day of lag after applying. 15 days after the first release candidate, check that its versions are gone (`gcloud artifacts docker tags list europe-west1-docker.pkg.dev/caelo-website/caelo-cms-images/admin | grep rc-`).

Known cosmetic leftover: cosign signature artifacts (`sha256-<digest>.sig` tags) of deleted images stay behind as orphaned versions in AR — they can't be prefix-matched without also matching release signatures, and at ~2 KB each they're not worth a bespoke GC. GHCR-side the cleanup action removes them together with their subject image.

## Operator deploy after mirror is live

Operators run `bunx @caelo-cms/provisioning --provider gcp` and Cloud Run pulls from the mirror — no operator-side AR repo, no copy step, no auth. To install a specific release, operators pass it to that release's own installer: `bunx @caelo-cms/provisioning@0.12.4 --provider gcp --version 0.12.4`.

To repoint at a different mirror project (e.g. when the dedicated `caelo-cms-public-registry` project is set up later):

```bash
pulumi config set caelo-gcp:public-registry-project caelo-cms-public-registry
pulumi config set caelo-gcp:public-registry-region us-central1   # if not europe-west1
```
