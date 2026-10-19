<!-- SPDX-License-Identifier: MPL-2.0 -->

# Releasing Caelo CMS

Caelo ships in **lockstep** — every workspace package, every container
image, and the `cms-provision` CLI all share one version number. One git
tag fans out into npm, GHCR, GCP Artifact Registry, and a GitHub Release
atomically.

This file is for maintainers cutting a release. Operators who want to
upgrade an existing install should read **["Upgrading"](#upgrading)**
at the bottom instead.

## At a glance

**One-button (preferred — no local checkout needed):** GitHub →
Actions → **release-cut** → *Run workflow* → pick `patch` / `minor` /
`major` (or an explicit `x.y.z`). CI runs the same
`scripts/release.ts`, opens a `chore(release): vX.Y.Z` PR, and once
that PR merges the workflow tags the merge commit and dispatches
`release.yml` automatically — identical artifacts to the local flow.

Before it bumps anything, release-cut requires the real-AI live-edit
suite (`e2e-livedit.yml`) to be green on the exact `main` commit being
released. Main gets no real-AI run per push, so the cut dispatches one
on that commit and waits for it (about 15 minutes, ~$4.50 of API spend);
a green run from an earlier attempt on the same commit is reused. A red
run stops the cut; fix main and re-run release-cut.

The same form carries the **release declaration** that gets signed into
the release manifest (see ["Release manifest"](#release-manifest)):
`security` + `advisories` for a security release,
`ack_contract_migrations` when the release carries destructive
migrations, `ack_infra_neutral` when infra-contract files changed
without an IAM/secret/resource change. These are checked first, before
the paid real-AI gate, so a refused declaration costs nothing.

One-time setup: CI needs the shipped-plugin manifest signing key
(release.ts re-signs the plugin manifests; the `TIER1` in the secret
and script names predates the single plugin model and is historical). The pair stored here IS the release
keypair from that point on — every published manifest verifies against
this public key, so it must be the ONE canonical pair, not an
arbitrary per-machine dev key. Source it from the team secrets
manager; extracting from a local `.caelo-dev-key` is only correct when
that file holds the canonical pair (the historical solo-maintainer
case, where every release so far was signed from it):

```bash
jq -r .privateKeyHex .caelo-dev-key | gh secret set CAELO_TIER1_PRIVATE_KEY
jq -r .publicKeyHex  .caelo-dev-key | gh variable set CAELO_TIER1_PUBLIC_KEY
```

To rotate: generate a fresh pair, update the secret + variable, and
ship a release so the manifests re-sign with the new key.

Merging the release PR: PRs opened with the repo `GITHUB_TOKEN` get no
workflow runs, so its required checks sit pending. Merge with
`gh pr merge --squash --admin` — safe, because `release.yml` re-runs
the full lint+typecheck+test gate on the tagged commit before anything
publishes. To make the PR's checks run like on any other PR (and allow
plain merging), add a `RELEASE_PAT` repo secret: a fine-grained PAT
with contents:write + pull-requests:write on this repo.

**Local flow (still works):**

```
bun scripts/release.ts patch        # 0.2.0 → 0.2.1 (or minor / major / x.y.z)
git push origin main --follow-tags  # fires release.yml + release-images.yml
```

That's it. Everything below is the *why* + the one-time setup needed
before the first tag.

---

## What gets published per tag

| Surface | Tags emitted |
|---|---|
| **npm** (`@caelo-cms/shared`, `@caelo-cms/mcp-server`, `@caelo-cms/provisioning`) | `0.2.1` published with the right [dist-tag](https://docs.npmjs.com/cli/dist-tag) — `latest` for stable, `rc` / `beta` for pre-releases. Auth via [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — no `NPM_TOKEN` secret, no 2FA bypass, short-lived credential exchanged from GitHub's OIDC token at publish time. Provenance attestation via the same OIDC. |
| **GHCR** (`ghcr.io/caelo-cms/{admin,gateway,ops}`) | `:0.2.1`, `:0.2`, `:latest` — pre-releases get the version-specific tag only (no `:latest`). Each image is signed with cosign (keyless / OIDC) for verifiable provenance. |
| **GCP Artifact Registry** (`europe-west1-docker.pkg.dev/caelo-website/caelo-cms-images/{admin,gateway,ops}`) | Same tags as GHCR, mirrored from GHCR by `release-images.yml`. Cloud Run pulls from here (Cloud Run rejects `ghcr.io` directly). |
| **GitHub Release** | `v0.2.1` with the `## v0.2.1` stanza from `CHANGELOG.md` as the body. Marked `prerelease: true` when the version contains a hyphen. Carries `release-manifest.json` + its Sigstore bundle. |
| **Release manifest** (`ghcr.io/caelo-cms/release-manifest:0.2.1`, mirrored to the AR repo above) | OCI artifact: the signed manifest + its Sigstore bundle as two layers. See ["Release manifest"](#release-manifest). |

`ops` is the `caelo-ops` image (`packages/provisioning/Dockerfile.ops`):
the provisioning CLI with pinned Bun, Node, Pulumi, gcloud (+ beta) and
cosign, multi-arch (amd64 + arm64), non-root, entry point `caelo-ops`.
It is what Cloud Shell installs and the in-cloud upgrader job run
(epic #696); every tool download is checksum-verified at build time.
To bump a tool, change its version ARG and both per-arch sha256 values
in the same commit, citing the vendor checksum file in the PR.

All four happen in parallel from the single `git push --follow-tags`
that lands the release commit.

---

## One-time setup

Before the first tag:

1. **Configure npm Trusted Publishing** for each publishable package
   (one-time per package). No long-lived token, no 2FA bypass.
   - For each of `@caelo-cms/shared`, `@caelo-cms/mcp-server` and
     `@caelo-cms/provisioning`:
     - Visit <https://www.npmjs.com/package/@caelo-cms/PACKAGE/access>
     - Scroll to **Trusted Publishers** → **Add Trusted Publisher**
     - Subject: **GitHub Actions**
     - Configuration:
       - **Organization or user**: `caelo-cms`
       - **Repository name**: `caelo-cms`
       - **Workflow filename**: `release.yml`
       - **Environment name**: leave blank
   - On publish, npm 11.5.1+ exchanges the GitHub OIDC token for a
     short-lived publish credential. The CI workflow already sets
     `permissions: id-token: write` and upgrades npm; nothing else
     to wire.
   - First-time publish for a brand-new package needs a one-time
     manual publish (or a temporary token) to create the package
     name; trusted publishing applies from the second release on.
     `shared`, `mcp-server` and `provisioning` were published in
     `0.1.x`. (`@caelo-cms/edge-router` was published from `0.10.23`
     until A/B routing left core in epic #676; it is deprecated on npm
     and no longer released.)
   - A new publishable workspace needs FOUR wire-ups or the release
     breaks at the verify gate (how v0.10.23 broke: `provisioning`
     depended on a then still-`private` workspace package, so the published
     tarball had an uninstallable dependency): `private: false` +
     dist build in its package.json, the publish matrix in
     `release.yml`, the verify loops in `release.yml`, and the npm
     Trusted Publisher config above.

2. **Generate a shipped-plugin signing key** (one per maintainer machine):
   ```bash
   bun apps/admin/scripts/sign-tier1-manifest.ts --new-key
   ```
   Persists to `.caelo-dev-key` (gitignored, mode 600). The release
   script re-signs every shipped plugin manifest using this key on
   each bump. For production releases, export
   `CAELO_TIER1_PRIVATE_KEY=<hex>` from your team secrets manager
   instead — the script picks that up over the local file.

3. **Make new GHCR packages public** (once per package). The first
   push of `ops` and `release-manifest` creates them as *private*
   GHCR packages; anonymous pulls (Cloud Shell, the upgrader, Compose)
   then fail. Open each under the org's Packages → Package settings →
   *Change visibility → Public*, and link it to this repository so the
   workflow token keeps package-admin on it (registry-retention.yml).

4. **Configure GCP Artifact Registry workload identity** (already done
   on `caelo-cms`; document here for fork operators):
   - In the GCP project `caelo-website`, set
     `GCP_PUBLIC_REGISTRY_WIF_PROVIDER`,
     `GCP_PUBLIC_REGISTRY_SA_EMAIL`,
     `GCP_PUBLIC_REGISTRY_PROJECT`,
     `GCP_PUBLIC_REGISTRY_REGION`,
     `GCP_PUBLIC_REGISTRY_REPO`
     as repository **vars** (not secrets). The release-images workflow
     mirrors GHCR → AR only when these are set; forks without them
     publish to GHCR only.

---

## Cutting a release

### 1. Decide the new version

Caelo follows SemVer 2.0:
- **patch**: bug fixes only, no schema migrations, no API changes.
- **minor**: new features, additive schema migrations (auto-applied
  by the migration runner), no breaking API changes.
- **major** (or pre-1.0 minor): breaking changes. Document the
  migration path in `CHANGELOG.md`.

### 2. Run the release script

```bash
bun scripts/release.ts patch       # 0.2.0 → 0.2.1
bun scripts/release.ts minor       # 0.2.0 → 0.3.0
bun scripts/release.ts major       # 0.2.0 → 1.0.0
bun scripts/release.ts 0.5.3       # explicit version
bun scripts/release.ts 0.6.0-rc.1  # pre-release
bun scripts/release.ts patch --dry-run   # preview without writing

# Release declaration (signed into the release manifest):
bun scripts/release.ts patch --security --advisories GHSA-xxxx-xxxx-xxxx
bun scripts/release.ts minor --ack-contract-migrations
bun scripts/release.ts patch --ack-infra-neutral
bun scripts/release.ts patch --checks-only   # run the release checks, change nothing
```

What the script does, in order:
1. Validates the new version is strictly greater than the current
   `CAELO_VERSION` (from `packages/shared/src/version.ts`), then runs
   the release-cut checks (security advisories, migration lint, infra
   contract — see ["Release manifest"](#release-manifest)) and writes
   the declaration to `release-meta.json`. A failed check stops here,
   before anything is bumped.
2. Updates the `CAELO_VERSION` constant and, for a stable release,
   moves the README's "Open in Cloud Shell" install links to
   `release-v<X.Y.Z>` (`scripts/cloud-shell-links.ts`; repo files only,
   see ["End-user docs"](#5-end-user-docs)).
3. Walks every workspace `package.json` and bumps `"version"` to match.
4. Re-signs every shipped plugin manifest under
   `packages/plugins/<slug>/` with the dev key (or
   `CAELO_TIER1_PRIVATE_KEY` if set).
5. Generates a `## v<X.Y.Z>` changelog stanza from conventional
   commits since the previous tag (groups `feat:` / `fix:` /
   `refactor:` / `docs:` / `chore:` / `test:` / `other`; flags
   `feat!:` / `fix!:` as ⚠ BREAKING) and prepends it to
   `CHANGELOG.md`.
6. `git add` the bumped files + `git commit -m "chore(release): vX.Y.Z"`.
7. `git tag -a vX.Y.Z -m "Caelo vX.Y.Z"`.

### 3. Push the tag

```bash
git push origin main --follow-tags
```

This fires two parallel workflows:
- **`release.yml`** — re-runs lint + typecheck + test + lockstep
  check; npm-publishes every non-private `@caelo-cms/*` package with
  provenance; creates the GitHub Release with the changelog stanza.
- **`release-images.yml`** — builds the admin, gateway and ops images,
  tags them, signs with cosign, mirrors GHCR → GCP Artifact Registry.
- **`release-manifest`** (job in `release.yml`) — builds, signs and
  publishes the release manifest once the images exist.

Both bind their artifacts to the same git SHA — the release is
atomic.

### 4. Verify

After both workflows go green:
```bash
npm view @caelo-cms/provisioning version    # → X.Y.Z
docker pull ghcr.io/caelo-cms/admin:X.Y.Z   # → succeeds
gh release view vX.Y.Z                      # → shows the changelog
```

### 5. End-user docs

The end-user docs are pages in the Caelo CMS on
[caelo-cms.com/docs](https://caelo-cms.com/docs/), not repo files
(CLAUDE.md §10), so the release commit does not touch them. After every
successful `release` run,
`.github/workflows/docs-sync.yml` prepares the docs work for the new
stable release (pre-releases are skipped):

- the merged PRs since the previous stable release that carry the
  `user-facing` label, each with its `## User docs affected` section, plus
  the release notes, turned into chat messages for Caelo's AI
  (`scripts/docs-sync.ts`, `scripts/docs-sync-prompt.ts`);
- the public developer reference (Plugin SDK, Query API, provisioning CLI)
  generated from the release tag for `/docs/reference/`
  (`scripts/docs-reference.ts`). These pages are repo-owned: each says so,
  carries `owner: repo` and links its source at the tag. Fix them here,
  never in the CMS.

Both land in the run's `docs-sync-release-vX.Y.Z` artifact and job
summary. A user-facing PR without the section (or with it left blank)
fails the run and is named in the summary: add the section to that PR's
description and re-run the workflow (Actions → docs-sync → Run workflow,
mode `release`, the tag). Re-runs are safe; the output is deterministic.

`workflow_dispatch` with mode `seed` turns the `docs/cms-seed` branch
(`seed/*.md`, frontmatter `path:` + `title:`) into one message per page,
for the initial fill of the docs section.

**Sending is not wired yet.** The workflow cannot reach caelo-cms.com's
admin through Google IAP without weakening CLAUDE.md §11.B (gap and
proposal on #827). Until then, open a new chat on caelo-cms.com, paste
the messages from the artifact in order, review the chat's preview and
publish by click. Nothing is ever published by the workflow: once sending
lands, the drafts still wait on the chat's preview branch for the Owner.

Maintainer setup for the send step (once #827's IAP access exists):

1. On caelo-cms.com, `/settings/mcp` → **New token**, name `docs-sync`,
   scope `chat` (Caelo's own AI drafts the pages; the token cannot drive
   tools directly), with an AI-spend cap. Copy the bearer shown once.
2. In the GitHub repo, Settings → Environments → **New environment**
   `docs-sync`; deployment branches: `main` only; optionally required
   reviewers. Add the secret `CAELO_MCP_TOKEN` (the bearer) there — never
   as a repository secret.
3. Revoke and re-mint the token at `/settings/mcp` if it ever leaks; the
   audit trail of every docs turn is at `/settings/audit/<requestId>`.

The docs update must also move the "Open in Cloud Shell" links on the
docs pages (`/docs/`, `/docs/quickstart/`, `/docs/install/google-cloud/`)
to `release-v<X.Y.Z>`. `scripts/release.ts` pins only the copies in this
repo (`CLOUD_SHELL_LINK_FILES`, the README) on purpose: it cannot edit
CMS content, and writing to the live site from the release commit would
bypass the Owner's publish click. The `release-v<X.Y.Z>` branch of
`caelo-cms/install` appears within about 30 minutes of the GitHub
Release, so publish the docs after it exists. Until sending is wired,
move the links by hand in the CMS.

---

## Release manifest

Every release ships one signed `release-manifest.json` (epic #696):

```json
{
  "manifestVersion": 1,
  "version": "0.11.0",
  "channel": "stable",
  "digests": { "admin": "sha256:…", "gateway": "sha256:…", "ops": "sha256:…" },
  "minFromVersion": "0.10.0",
  "infraContractVersion": 1,
  "migrations": { "contract": false, "head": "0262_tool_approval_branch", "lastContractVersion": "0.10.42" },
  "security": false,
  "advisories": []
}
```

`release.yml`'s `release-manifest` job builds it after the images are
pushed (digests resolved from the version tags), re-runs every
release-cut check against `release-meta.json`, signs it with
`cosign sign-blob` (keyless, identity
`https://github.com/caelo-cms/caelo-cms/.github/workflows/release.yml@refs/tags/vX.Y.Z`),
pushes it as an OCI artifact to GHCR, mirrors it to the AR, and
verifies the mirror copy through the same library the upgrader uses
(`packages/provisioning/src/release-manifest.ts`). npm publishing and
the GitHub Release wait for it. Because the identity names the tag,
**release.yml must run on the tag ref**: a manual dispatch uses
`gh workflow run release.yml --ref vX.Y.Z -f tag=vX.Y.Z` (the job
refuses any other ref).

Verify one by hand:

```bash
gh release download vX.Y.Z -p 'release-manifest.json*'
cosign verify-blob --bundle release-manifest.json.sigstore.json \
  --certificate-identity https://github.com/caelo-cms/caelo-cms/.github/workflows/release.yml@refs/tags/vX.Y.Z \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  release-manifest.json
```

### Security releases

`security: true` is the only thing that lets an Owner's "auto-install
security fixes" policy apply a release unattended, so it is hard to set:

- It comes **only** from the release-cut input `security` (or
  `release.ts --security`), together with `advisories` — a comma list
  of GHSA ids.
- The cut (and again `release.yml`, before signing) refuses unless every
  id resolves to a **published** GitHub Security Advisory of this repo
  (`GET /repos/caelo-cms/caelo-cms/security-advisories/<id>`, state
  `published`). Drafts do not count. CVE ids are not accepted — the
  GHSA carries the CVE.
- Advisories without `security`, or `security` without advisories, are
  refused.
- The manifest is signed by the release workflow, so a compromised
  admin or registry mirror cannot turn a normal release into a
  "security" one.

A security release must also be expand-only and keep the infra
contract. If it carries contract migrations or raises
`infraContractVersion`, the cut still succeeds (with a warning) and the
manifest still says `security: true` — but the upgrader treats it as
**manual**: it is never auto-installed, and the admin offers "Run in
Cloud Shell" with the reason (`assessAutoInstall` in
`release-manifest.ts`). The infra comparison is against the *installed*
contract version, so a bump in any skipped release counts too.

### Contract migrations

Migrations are expand-only: the previous release's image must run on
the new schema. `scripts/migration-lint.ts` scans the SQL migrations
**added** since the previous stable tag for DROP TABLE / COLUMN /
SCHEMA / TYPE / VIEW / DOMAIN / SEQUENCE / FUNCTION, ALTER TYPE, RENAME
and ALTER COLUMN … TYPE (DROP POLICY / CONSTRAINT / INDEX / TRIGGER are
routine recreate patterns and not flagged — except a **UNIQUE** index or
constraint, named `*_uidx` / `*_unique` / `*_uniq` / `*_key`, that the
same migration does not recreate under that name: relaxing uniqueness
breaks the previous image's `ON CONFLICT` targets and lookups, rule
`drop-unique`). SQL inside `DO $$ … $$` /
function bodies is linted including its string literals, so
`EXECUTE 'DROP TABLE …'` counts. Any finding sets
`migrations.contract: true`, and the cut is refused unless
`ack_contract_migrations` (`--ack-contract-migrations`) acknowledges
it. Such a release is never auto-installed. Prefer shipping the
destructive step one release after the code stopped using the object.

Some breaks are semantic and no pattern sees them. A migration declares
itself contract with a line in its leading comment header (before the
first statement):

```sql
-- SPDX-License-Identifier: MPL-2.0
-- caelo:contract <why the previous image cannot run on this schema>
```

The reason is required (a bare marker fails the lint) and appears as a
`marked-contract` finding, so the cut's acknowledgement shows it.

When a contract migration only works on an install that already ran
the release with its expand half, it says so in the same header:

```sql
-- caelo:requires-earlier-run 0281_public_projection_outbox.sql
```

The migration runner (`packages/migrations/src/run-order.ts`) then
refuses the whole run, before applying anything, on an existing install
where an earlier run did not record that migration. An install that
skips the expand release cannot apply both halves at once, whichever
path upgrades it (in-cloud upgrader, `cms-provision upgrade`, the host
agent). The error tells the operator which release to install first. A
fresh database (nothing recorded) applies everything in one run. The
named migration must sort before the one naming it; a unit test checks
every shipped header.

`migrations.lastContractVersion` carries the newest contract release
forward (the release itself when it has contract migrations, else the
previous release's value, recorded in `release-meta.json` by
`release.ts` and re-derived by `release.yml`). An install below it that
would jump straight to a later release is also **manual**: skipping the
contract release does not make its destructive migrations safe.

```bash
bun scripts/migration-lint.ts               # since the previous stable tag
bun scripts/migration-lint.ts --since v0.10.30
```

### Infra contract

`INFRA_CONTRACT_VERSION` in `packages/provisioning/src/infra-contract.ts`
(the same number the upgrade's `needsConverge` checks) says which IAM bindings, secrets, service accounts and cloud resources
the release's images need. The upgrader job can only roll images, so an
install whose recorded value is lower installs the release through the
converge job instead (#819): the Owner clicks the same Update button, the
admin routes the release to `caelo-<env>-converge`, which runs the whole
upgrade (backup, converge, roll, health check, rollback) from the
release's own signed ops image as the install's `caelo-provisioner`.
Installs set up before contract 9 (which adds that job) take one last
converge from a terminal (Cloud Shell / CLI); `./run.sh upgrade` stays
the break-glass path for when the job itself cannot run.

**Bump it by one** in any release whose stacks or upgrade-time converge
add, remove or change IAM, secrets, service accounts or resources. The
release checks diff the files in `INFRA_CONTRACT_PATHS` (the stacks,
`stack-contract.ts`, `stack-converge.ts`, `runtime-secrets.ts`,
`operator-access.ts`, `gcp-names.ts`, and the upgrade-time mutators
`upgrade/converge.ts`, `mcp-iap.ts`, `default-firewall.ts`, the
upgrader's and the converge job's setup; listed in
`release-contract.ts`; tests and READMEs excluded) against the previous stable tag: if any changed and the number did
not, the cut is refused. When the change is infra-neutral (a comment, a
refactor, a log line), re-cut with `ack_infra_neutral`
(`--ack-infra-neutral`) instead. The number never goes down.

**Rollback across a bump.** The automatic rollback inside `upgrade` keeps
working, because retired bindings and env are removed only after both
services run the new release. A rollback *after* the upgrade finished is
not: the older release's revisions may need IAM bindings, secrets or env
the newer one removed, and the in-cloud upgrader can neither change IAM
nor install an older release. Operators roll back by running the older
release's CLI (`bunx @caelo-cms/provisioning@<old> upgrade --version
<old>`), which re-applies that release's env contract and bindings. A
release that bumps the number says so in its release notes (PR body) and
names what the older release needs back; the GCP install page in the docs
at caelo-cms.com/docs/ ("Rolling back to an earlier release") carries the
procedure.

`minFromVersion` comes from `RELEASE_MIN_FROM_VERSION` in `release-contract.ts`;
raise it when a release needs an intermediate stop.

---

## Pre-releases

Tag with a hyphen suffix:

```bash
bun scripts/release.ts 0.6.0-rc.1
git push origin main --follow-tags
```

The release pipeline:
- Publishes npm with `--tag rc` (so `npm install @caelo-cms/provisioning`
  still gets the prior stable; opt-in via `npm install @caelo-cms/provisioning@rc`).
- Tags the Docker image `:0.6.0-rc.1` and `:rc`, but **not** `:latest`.
- Marks the GitHub Release as pre-release.

Operators opt in via `bunx @caelo-cms/provisioning upgrade --channel rc`.

---

## Upgrading

If you're an **operator** running a Caelo install (not a maintainer
cutting a release), use the lifecycle CLI:

```bash
bunx @caelo-cms/provisioning status                # show current vs. latest
bunx @caelo-cms/provisioning upgrade               # → :latest stable
bunx @caelo-cms/provisioning upgrade --version 0.5.3
bunx @caelo-cms/provisioning upgrade --channel rc  # opt into pre-releases
```

The admin app's notification bell also shows a "vX.Y.Z available"
entry when running version is stale (24h-cached check against the
GitHub Releases API).

**Pulumi state location (#696).** New GCP installs keep Pulumi's state,
`install.json` and `progress.json` in `gs://<project>-caelo-ops` with a
Cloud KMS key (`caelo/pulumi-state`) as secrets provider. Installs from
before that keep them in `~/.caelo-<id>/` until the operator runs
`bunx @caelo-cms/provisioning state migrate --install <id>` (`upgrade`
prints the reminder). A release must not change the `stateBackend` shape
in `install.json` or the bucket layout (`pulumi/`, `install/`) without a
migration in `state migrate`. Maintainer dogfood order for the move:
caelo-cms.com → viu.one → searchviu (dry run first, each one verified with
`status` before the next).

---

## Lockstep enforcement

CI runs `bun scripts/release.ts --check` on every push. PRs that
hand-edit a single `package.json` `version` field fail the check —
all bumps must go through the release script.

If the check fails locally:
```bash
bun scripts/release.ts --check
# ✗ 1 package(s) drift from v0.2.0:
#   ./packages/admin-core/package.json: 0.2.1
```
Either revert the hand-edit, or run a real bump via the script.
