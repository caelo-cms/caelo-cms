# Bug intake — maintainer runbook

The bug intake (`apps/bug-intake`, epic #901) receives the AI-detected bug reports of every Caelo install whose Owner opted in on `/settings/bugs`. It merges reports of the same defect across installs and files **one public GitHub issue per defect** in `caelo-cms/caelo-cms`. Operators need no GitHub account; installs talk only to the intake.

This is a service the Caelo project runs once, for everyone. It is not part of an install, and the provisioner never deploys it.

## How it works

```
install ──signed POST──▶ bug intake (Cloud Run, 1 instance) ──GitHub App──▶ issue in caelo-cms/caelo-cms
                          clusters, pinned keys, raw reports
                          ──▶ JSON files in the private data repo
        ◀── cluster status (open / fixed in vX / regression / wontfix) ──
```

- **Identity.** On opt-in an install generates an Ed25519 key and registers it (`POST /v1/installs`); the intake pins the first key per install id. Every report is signed over method, path, timestamp and body hash, with a 5-minute replay window. Contract: `packages/shared/src/bug-intake.ts`.
- **One issue per defect.** A report joins a cluster by its fingerprint (computed on the install from tool + normalised error text, version-independent). AI-filed reports with a new fingerprint are compared with the recent clusters of the same tool by a model (`BUG_INTAKE_MATCH_MODEL`); only a high-confidence match merges. Otherwise a new cluster starts.
- **Threshold.** A cluster gets its issue once `BUG_INTAKE_ISSUE_THRESHOLD_INSTALLS` distinct installs reported it. It is `1` today (every defect gets an issue). Raise it when the volume grows; that is a config change, no install release.
- **Repeat reports** update the counters only: the issue body is refreshed when a new install or Caelo version appears, and a comment is added at 10 / 100 / 1,000 / 10,000 installs.
- **Privacy.** Reports are redacted on the install and again on the intake. The public issue shows the structured fields and the redacted description inside code fences (no @mentions, no cross-references). `evidence` never leaves the private data repo.

## Closing the loop: what maintainers do on an issue

The intake reads an issue's state lazily (at most every 5 minutes per cluster, when a report or status request touches it). No webhook is needed.

| You do | Installs see |
|---|---|
| Close as **completed** (e.g. via `Fixes #N` in the PR) | "Fixed", then "Fixed in vX" once the first release after the close is published |
| Add label `fixed-in:0.11.2` before or after closing | "Fixed in 0.11.2" (overrides the release guess) |
| Close as **not planned** | "Won't be fixed" |
| Close as **duplicate** (GitHub writes "Duplicate of #M") | Reports follow #M from then on; counts merge if #M is also an intake issue |
| Nothing; a report arrives from a version ≥ the fix | The intake reopens the issue and comments "regression" |

## One-time setup

1. **Data repo.** Create the private repository `caelo-cms/bug-intake-data` (empty, with a README so it has a default branch).
2. **GitHub App** (organisation settings → Developer settings → GitHub Apps → New):
   - Name `caelo-bug-intake`, no webhook (uncheck *Active*).
   - Repository permissions: **Issues: read & write**, **Contents: read & write**, **Metadata: read**.
   - Create, then generate a private key (downloads a `.pem`).
   - Install the App on the organisation, **only** on `caelo-cms/caelo-cms` and `caelo-cms/bug-intake-data`. The installation id is the number at the end of the installation's settings URL.
3. **Labels** in `caelo-cms/caelo-cms`: `ai-detected`, `severity:blocking`, `severity:degraded`, `severity:cosmetic`.
4. **Secrets** (Secret Manager in the hosting project): `bug-intake-github-app-key` (the `.pem`), `bug-intake-anthropic-key`.

## Deploy (Cloud Run)

From the repository root, in the GCP project that hosts Caelo's own services:

```sh
PROJECT=caelo-website
REGION=europe-west1
IMAGE=$REGION-docker.pkg.dev/$PROJECT/caelo-cms-images/bug-intake:$(git rev-parse --short HEAD)

docker build -f apps/bug-intake/Dockerfile -t "$IMAGE" .
docker push "$IMAGE"

gcloud run deploy caelo-bug-intake --project "$PROJECT" --region "$REGION" \
  --image "$IMAGE" --allow-unauthenticated \
  --min-instances 0 --max-instances 1 --concurrency 20 --memory 256Mi \
  --set-env-vars "GITHUB_APP_ID=<app id>,GITHUB_APP_INSTALLATION_ID=<installation id>,BUG_INTAKE_PUBLIC_REPO=caelo-cms/caelo-cms,BUG_INTAKE_DATA_REPO=caelo-cms/bug-intake-data,BUG_INTAKE_ISSUE_THRESHOLD_INSTALLS=1,BUG_INTAKE_MATCH_MODEL=claude-haiku-5-5" \
  --set-secrets "GITHUB_APP_PRIVATE_KEY=bug-intake-github-app-key:latest,ANTHROPIC_API_KEY=bug-intake-anthropic-key:latest"

gcloud beta run domain-mappings create --project "$PROJECT" --region "$REGION" \
  --service caelo-bug-intake --domain bugs.caelo-cms.com
```

`--max-instances 1` is load-bearing: writes to one cluster are serialised in-process, and the per-install rate limits live in memory. The service refuses to start if any variable is missing and names it.

Check: `curl https://bugs.caelo-cms.com/healthz` → `ok`. Then turn on forwarding on a dev install, file a bug report, and watch the issue appear (the install's worker sends within a minute).

## Limits and the next step

Storage is the GitHub API: a report costs about five calls, and an App installation has 5,000 an hour, so roughly 1,000 reports an hour. Install hashes per cluster are capped at 10,000. When volume approaches either, move `IntakeStore` (`apps/bug-intake/src/store.ts`) to a database (Firestore or Cloud SQL). The service logic does not change.

## Local run

```sh
PORT=8787 GITHUB_APP_ID=… GITHUB_APP_PRIVATE_KEY="$(cat key.pem)" GITHUB_APP_INSTALLATION_ID=… \
BUG_INTAKE_PUBLIC_REPO=<your fork> BUG_INTAKE_DATA_REPO=<a private test repo> \
BUG_INTAKE_ISSUE_THRESHOLD_INSTALLS=1 ANTHROPIC_API_KEY=… BUG_INTAKE_MATCH_MODEL=claude-haiku-5-5 \
bun apps/bug-intake/src/main.ts
```

Point a dev install at it with `CAELO_BUG_INTAKE_URL=http://localhost:8787`.
