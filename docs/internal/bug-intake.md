# Operating a bug intake

The bug intake (`apps/bug-intake`, epic #901) receives the AI-detected bug reports of every Caelo install whose Owner opted in on `/settings/bugs`. It merges reports of the same defect across installs and files **one GitHub issue per defect** in one repository. Operators of installs need no GitHub account; installs talk only to the intake.

Installs send to `https://bugs.caelo-cms.com` by default, the intake the Caelo project runs for upstream. The intake is not part of an install and the provisioner never deploys it. This guide is for whoever runs an intake: the Caelo maintainers for upstream, or a fork that wants reports of its own installs filed in its own repository. How any one operator hosts its intake (project, registry, domain) is kept outside this repository.

## How it works

```
install ──signed POST──▶ bug intake (1 instance) ──GitHub App──▶ issue in <owner>/<repo>
                          clusters, pinned keys, raw reports
                          ──▶ Firestore (the intake's own database)
        ◀── cluster status (open / fixed in vX / regression / wontfix) ──
```

Endpoints: `GET /health` and `GET /healthz` (liveness), `POST /v1/installs` (register a key, unsigned), `POST /v1/reports` and `POST /v1/clusters/status` (signed). The contract lives in `packages/shared/src/bug-intake.ts`.

- **Signed requests.** On opt-in an install generates an Ed25519 key pair and registers the public key. Every report and status request is signed over method, path, timestamp and body hash; the intake refuses an unknown install, a bad signature, or a timestamp more than 5 minutes off.
- **Trust on first use.** The intake pins the first key it sees for an install id and refuses a different key for that id later (409). Registration itself is unauthenticated: anyone can register an install id and, at threshold 1, get an issue filed. Nothing proves that a registering client is a real Caelo install. Spam is therefore **bounded, not prevented**: by the daily issue cap, the kill switch, the per-address and global registration limits, and the per-install request limit.
- **One issue per defect.** A report joins a cluster by its fingerprint (computed on the install from tool and normalised error text, independent of the Caelo version). An AI-filed report with a new fingerprint is compared with the recent clusters of the same tool by a model (`BUG_INTAKE_MATCH_MODEL`); only a high-confidence match merges. Otherwise a new cluster starts.
- **Threshold.** A cluster gets its issue once `BUG_INTAKE_ISSUE_THRESHOLD_INSTALLS` distinct installs reported it.
- **Daily cap.** At most `BUG_INTAKE_MAX_NEW_ISSUES_PER_DAY` new issues per UTC calendar day. The counter lives in Firestore, so restarts and scale-to-zero do not reset it. A defect due an issue over the cap is stored and counted as usual and queued; queued defects are filed oldest first, at most three per incoming request, once the next day's slots exist. Every install refreshes its cluster status at least every six hours, so a queued defect waits at most that long past 00:00 UTC. Existing issues are not capped: body refreshes, milestone comments and regression reopens continue.
- **Kill switch.** `BUG_INTAKE_ISSUES_PAUSED=true` stops every GitHub write (no issue created, edited, reopened or commented). Reports are still accepted, counted and stored, and defects due an issue are queued.
- **Repeat reports** update the counters only: the issue body is refreshed when a new install or Caelo version appears, and a comment is added at 10 / 100 / 1,000 / 10,000 installs.
- **Privacy.** Reports are redacted on the install before they are queued (email addresses, links, IP addresses, phone numbers, tokens, keys) and redacted again on the intake, so a modified client cannot skip it. The issue shows the structured fields and the redacted description inside code fences (no @mentions, no cross-references). The `evidence` field is never published: it stays in the intake's Firestore database, readable only by its operator.

## One-time setup

You need a GitHub organisation or account that owns the target repository, and a cloud project to run the service in. The examples use Google Cloud (Firestore is the intake's only supported store); placeholders are in angle brackets or shell variables.

### 1. GitHub App

The App's only power is filing and updating issues in one repository. A compromised intake cannot push code, read private repositories or touch settings.

Save this manifest, replacing the placeholders:

```json
{
  "name": "<owner>-bug-intake",
  "url": "https://github.com/<owner>/<repo>",
  "public": false,
  "redirect_url": "http://localhost:8765/",
  "default_permissions": {
    "issues": "write",
    "metadata": "read"
  },
  "default_events": []
}
```

There is no `hook_attributes`, so the App has no webhook: the intake reads issue state on demand. Issues write includes read. The release list the intake reads to name "fixed in vX" is public data of a public repository and needs no Contents permission. If the target repository is private, add `"contents": "read"`; otherwise leave the permissions exactly as above.

Create the App from the manifest. Save this as a local HTML file with the manifest pasted into `value`, open it in a browser signed in to GitHub, and submit:

```html
<form action="https://github.com/organizations/<org>/settings/apps/new" method="post">
  <input type="hidden" name="manifest" value='<manifest JSON>'>
  <button>Create GitHub App</button>
</form>
```

For a personal account use `https://github.com/settings/apps/new`. GitHub shows the App for confirmation, then redirects to `http://localhost:8765/?code=<code>`. Nothing needs to listen there; copy the code from the address bar. Within one hour, exchange it for the App's credentials:

```sh
curl -fsS -X POST "https://api.github.com/app-manifests/<code>/conversions" > app.json
jq -r .id app.json          # GITHUB_APP_ID
jq -r .pem app.json > app.pem
```

Put `app.pem` into the secret manager (step 3) and delete both local files.

Install the App: App settings → Install App → choose the owner → **Only select repositories** → the target repository, nothing else. The installation id (`GITHUB_APP_INSTALLATION_ID`) is the number at the end of the installation's settings URL.

Create the labels the intake applies in the target repository: `ai-detected`, `severity:blocking`, `severity:degraded`, `severity:cosmetic`.

### 2. Firestore and a runtime service account

Create a Firestore database in Native mode that belongs to the intake alone, and a service account the service runs as. The account gets `roles/datastore.user` with an IAM condition limiting it to that database. No key file: the service authenticates as its runtime service account.

```sh
PROJECT=<project id>
DB=bug-intake
SA=bug-intake@$PROJECT.iam.gserviceaccount.com

gcloud firestore databases create --project "$PROJECT" --database "$DB" \
  --location <location> --type firestore-native
gcloud iam service-accounts create bug-intake --project "$PROJECT"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:$SA" --role roles/datastore.user \
  --condition "title=bug-intake-db-only,expression=resource.name == \"projects/$PROJECT/databases/$DB\""
```

### 3. Secrets

Two secrets, both in the secret manager, never in environment literals or files: the App private key and the model API key. The service account may read these two and nothing else.

```sh
gcloud secrets create bug-intake-github-app-key --project "$PROJECT" --data-file app.pem
printf %s "<model API key>" | gcloud secrets create bug-intake-model-key --project "$PROJECT" --data-file -
for s in bug-intake-github-app-key bug-intake-model-key; do
  gcloud secrets add-iam-policy-binding "$s" --project "$PROJECT" \
    --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor
done
```

## Deploy

Every merge to `main` that changes the intake publishes a signed image (`.github/workflows/bug-intake-image.yml`):

- `ghcr.io/caelo-cms/bug-intake:<full commit sha>`, immutable, the tag to pick a release from;
- `ghcr.io/caelo-cms/bug-intake:main`, moving.

Do not build the image yourself. Pick a commit, resolve its digest, and deploy that digest only.

### Verify

```sh
IMAGE=ghcr.io/caelo-cms/bug-intake
DIGEST=$(oras resolve "$IMAGE:<full commit sha>")

cosign verify "$IMAGE@$DIGEST" \
  --certificate-identity="https://github.com/caelo-cms/caelo-cms/.github/workflows/bug-intake-image.yml@refs/heads/main" \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com"

cosign verify-attestation "$IMAGE@$DIGEST" --type spdxjson \
  --certificate-identity="https://github.com/caelo-cms/caelo-cms/.github/workflows/bug-intake-image.yml@refs/heads/main" \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com"
```

The identity is exact, not a pattern: only that workflow, run on `main`, produces a passing signature. The second command checks the SPDX SBOM attested with the same identity. If either fails, do not deploy. A fork that publishes its own image verifies against its own workflow identity instead.

### Run

Cloud Run pulls from Artifact Registry or Docker Hub, not from GHCR, so copy the verified digest into a repository of your own first. A copy keeps the digest, so the image you deploy is the one you verified:

```sh
MIRROR=<region>-docker.pkg.dev/$PROJECT/<repository>/bug-intake
oras copy -r "$IMAGE@$DIGEST" "$MIRROR:<full commit sha>"

gcloud run deploy bug-intake --project "$PROJECT" --region <region> \
  --image "$MIRROR@$DIGEST" --allow-unauthenticated \
  --min-instances 0 --max-instances 1 --concurrency 20 --memory 256Mi \
  --service-account "$SA" \
  --set-env-vars "GITHUB_APP_ID=<app id>,GITHUB_APP_INSTALLATION_ID=<installation id>,BUG_INTAKE_PUBLIC_REPO=<owner>/<repo>,BUG_INTAKE_FIRESTORE_PROJECT=$PROJECT,BUG_INTAKE_FIRESTORE_DATABASE=$DB,BUG_INTAKE_ISSUE_THRESHOLD_INSTALLS=1,BUG_INTAKE_MAX_NEW_ISSUES_PER_DAY=20,BUG_INTAKE_ISSUES_PAUSED=false,BUG_INTAKE_MAX_REGISTRATIONS_PER_HOUR=200,BUG_INTAKE_MATCH_MODEL=<model id>" \
  --set-secrets "GITHUB_APP_PRIVATE_KEY=bug-intake-github-app-key:latest,ANTHROPIC_API_KEY=bug-intake-model-key:latest"
```

Then map your domain to the service. The service refuses to start if any variable is missing or invalid and names each one.

### Check

`curl https://<your intake domain>/health` → `ok`. Use `/health` for every check from outside: Cloud Run's front end reserves paths ending in `z` and answers `/healthz` with its own 404, on `*.run.app` and on mapped domains, so the request never reaches the container. `/healthz` stays for container probes.

A deeper smoke check sends a status request as an install that was never registered:

```sh
curl -sS -X POST "https://<your intake domain>/v1/clusters/status" \
  -H "x-caelo-install-id: $(uuidgen)" \
  -H "x-caelo-timestamp: $(( $(date +%s) * 1000 ))" \
  -H "x-caelo-signature: AA==" \
  -d '{}'
```

Expect `401` with `{"error":"Unknown install; register its key first.","retryable":true}`: the service started with a complete configuration and read the install key from Firestore. A `503` means the Firestore read failed; check the database id and the service account's `roles/datastore.user` binding and its condition. A `401` about the timestamp means the local clock is more than 5 minutes off.

**One instance is load-bearing** (`--max-instances 1`). Writes to one cluster are serialised by an in-process lock, and the rate limits (registrations per address, registrations overall, requests per install) are counted in memory. A second instance would halve every limit's effect and let two processes race on the same cluster; the store's version check would turn most races into retries, but a duplicate issue or a doubled comment is still possible. One instance with concurrency 20 is far more than the traffic needs. A restart resets the in-memory windows, which is acceptable for abuse damping; the daily issue counter is in Firestore and survives restarts.

The per-address limit reads the caller's address from the last `x-forwarded-for` hop, which is what Cloud Run appends. On another platform, make sure the proxy in front of the intake appends the client address the same way.

## Configuration reference

Every variable is required (`apps/bug-intake/src/config.ts`); there are no defaults in the service. The starting values are what a new intake should begin with.

| Variable | Meaning | Allowed values | Start with |
|---|---|---|---|
| `PORT` | Port the HTTP server listens on. | Integer ≥ 1. | Injected by Cloud Run; `8080` elsewhere (the image exposes 8080). |
| `GITHUB_APP_ID` | Id of the GitHub App that files the issues. | Non-empty. | From the manifest conversion (`.id`). |
| `GITHUB_APP_PRIVATE_KEY` | The App's private key, PEM. From the secret manager. | PEM containing `PRIVATE KEY` (PKCS#1 as GitHub issues it, or PKCS#8). | The `.pem` from the conversion. |
| `GITHUB_APP_INSTALLATION_ID` | The App's installation on the target repository. | Digits. | From the installation's settings URL. |
| `BUG_INTAKE_PUBLIC_REPO` | Repository the issues are filed in. | `owner/repo`. | Your repository. |
| `BUG_INTAKE_FIRESTORE_PROJECT` | GCP project of the Firestore database. Named explicitly so the intake never writes into whatever project it happens to run in. | GCP project id (6–30 chars, lowercase, digits, hyphens). | Your project. |
| `BUG_INTAKE_FIRESTORE_DATABASE` | Firestore database holding clusters, pinned keys and raw reports. | `(default)` or a database id (4–63 chars, lowercase, digits, hyphens). | `bug-intake`. |
| `BUG_INTAKE_ISSUE_THRESHOLD_INSTALLS` | Distinct installs a defect needs before it gets an issue. | Integer ≥ 1. | `1` (every defect gets an issue). |
| `BUG_INTAKE_MAX_NEW_ISSUES_PER_DAY` | New issues per UTC day; the rest are queued for later days. | Integer ≥ 1. | `20`. |
| `BUG_INTAKE_ISSUES_PAUSED` | Kill switch: `true` = no GitHub write of any kind. | Exactly `true` or `false`; anything else stops the service at boot. | `false`. |
| `BUG_INTAKE_MAX_REGISTRATIONS_PER_HOUR` | Registrations per hour across all clients, on top of the fixed per-address limit (20 per hour). | Integer ≥ 1. | `200`. |
| `ANTHROPIC_API_KEY` | Key for the model that matches differently worded AI reports of the same defect. From the secret manager. | Non-empty. | Your key. |
| `BUG_INTAKE_MATCH_MODEL` | Model id used for that matching. A small, fast model is enough. | Non-empty model id. | The current small Claude model. |

Fixed limits (not configurable): 120 signed requests per install per hour, 64 KB per request, 10,000 install hashes stored per cluster (beyond that the count shows as "N+").

## Operating it

**Pause in an incident** (spam wave, wrong issues):

```sh
gcloud run services update bug-intake --project "$PROJECT" --region <region> \
  --update-env-vars BUG_INTAKE_ISSUES_PAUSED=true
```

Installs keep sending and nothing is lost; nothing reaches GitHub. Set it back to `false` the same way: the queue is filed under the daily cap, and skipped edits catch up on the next report that would make them. While paused, regressions are not reopened either.

**Raising the threshold.** When the volume grows, set `BUG_INTAKE_ISSUE_THRESHOLD_INSTALLS` higher (for example `2`). It is a config change on the intake, no install release. It applies to defects that have no issue yet; existing issues stay.

**Raising the cap.** If real defects queue for days, raise `BUG_INTAKE_MAX_NEW_ISSUES_PER_DAY`. If the queue is spam, pause first and clean up before raising anything.

**Upgrading.** Verify the new digest as above, copy it, and redeploy with `--image "$MIRROR@<new digest>"`. Configuration and data carry over.

### Closing the loop: what maintainers do on an issue

The intake reads an issue's state lazily (at most every 5 minutes per cluster, when a report or status request touches it). No webhook is needed.

| You do | Installs see |
|---|---|
| Close as **completed** (e.g. via `Fixes #N` in the PR) | "Fixed", then "Fixed in vX" once the first release published after the close exists |
| Add label `fixed-in:0.11.2` before or after closing | "Fixed in 0.11.2" (overrides the release guess) |
| Close as **not planned** | "Won't be fixed" |
| Close as **duplicate** (GitHub writes "Duplicate of #M") | Reports follow #M from then on; counts merge if #M is also an intake issue |
| Reopen | "Open" again |
| Nothing; a report arrives from a version ≥ the fix | The intake reopens the issue and comments that it is a regression |

## Forks

A fork that wants reports from its installs filed in its own repository runs its own intake as above, with its own App installed on its own repository, and points its installs at it by setting `CAELO_BUG_INTAKE_URL=https://<your intake domain>` in the admin's environment. Without the variable, installs send to `https://bugs.caelo-cms.com`. What installs send is documented in [`docs/TELEMETRY.md`](../TELEMETRY.md).

## Local run

Start the Firestore emulator, then the intake from the repository root against it. Use a test repository of your own and an App installed only there.

```sh
gcloud emulators firestore start --host-port=127.0.0.1:8915
```

```sh
PORT=8787 GITHUB_APP_ID=… GITHUB_APP_PRIVATE_KEY="$(cat app.pem)" GITHUB_APP_INSTALLATION_ID=… \
BUG_INTAKE_PUBLIC_REPO=<owner>/<test repo> FIRESTORE_EMULATOR_HOST=127.0.0.1:8915 \
BUG_INTAKE_FIRESTORE_PROJECT=bug-intake-local BUG_INTAKE_FIRESTORE_DATABASE='(default)' \
BUG_INTAKE_ISSUE_THRESHOLD_INSTALLS=1 BUG_INTAKE_MAX_NEW_ISSUES_PER_DAY=5 BUG_INTAKE_ISSUES_PAUSED=false \
BUG_INTAKE_MAX_REGISTRATIONS_PER_HOUR=50 ANTHROPIC_API_KEY=… BUG_INTAKE_MATCH_MODEL=<model id> \
bun apps/bug-intake/src/main.ts
```

Point a dev install at it with `CAELO_BUG_INTAKE_URL=http://localhost:8787`, turn on forwarding on `/settings/bugs`, file a bug report, and watch the issue appear (the install's worker sends within a minute).

The store tests run against the same emulator: with `FIRESTORE_EMULATOR_HOST=127.0.0.1:8915` set, `bun test apps/bug-intake/src/firestore-store.test.ts`. Without the variable the suite skips and says so; CI starts the emulator and sets `CAELO_FIRESTORE_EMULATOR=required`, which turns a missing emulator into a failure.

## Limits

GitHub is used for issues only: a report costs at most a few issue calls (none while the cap or the kill switch holds it back), well inside an App installation's 5,000 calls an hour. Registration is trust on first use; proving that a registering client is a real Caelo install is a later step.
