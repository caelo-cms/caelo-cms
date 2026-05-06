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
| **npm** (`@caelo-cms/mcp-server`, `@caelo-cms/provisioning`) | `0.2.1` published with the right [dist-tag](https://docs.npmjs.com/cli/dist-tag) — `latest` for stable, `rc` / `beta` for pre-releases. Auth via [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — no `NPM_TOKEN` secret, no 2FA bypass, short-lived credential exchanged from GitHub's OIDC token at publish time. Provenance attestation via the same OIDC. |
| **GHCR** (`ghcr.io/caelo-cms/{admin,gateway}`) | `:0.2.1`, `:0.2`, `:latest` — pre-releases get the version-specific tag only (no `:latest`). Each image is signed with cosign (keyless / OIDC) for verifiable provenance. |
| **GCP Artifact Registry** (`europe-west1-docker.pkg.dev/caelo-website/caelo-cms-images/{admin,gateway}`) | Same tags as GHCR, mirrored from GHCR by `release-images.yml`. Cloud Run pulls from here (Cloud Run rejects `ghcr.io` directly). |
| **GitHub Release** | `v0.2.1` with the `## v0.2.1` stanza from `CHANGELOG.md` as the body. Marked `prerelease: true` when the version contains a hyphen. |

All four happen in parallel from the single `git push --follow-tags`
that lands the release commit.

---

## One-time setup

Before the first tag:

1. **Configure npm Trusted Publishing** for each publishable package
   (one-time per package). No long-lived token, no 2FA bypass.
   - For each of `@caelo-cms/mcp-server` and `@caelo-cms/provisioning`:
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
     Both Caelo packages were already published in `0.1.x`, so this
     gate is past.

2. **Generate a Tier-1 plugin signing key** (one per maintainer machine):
   ```bash
   bun apps/admin/scripts/sign-tier1-manifest.ts --new-key
   ```
   Persists to `.caelo-dev-key` (gitignored, mode 600). The release
   script re-signs every Tier-1 plugin manifest using this key on
   each bump. For production releases, export
   `CAELO_TIER1_PRIVATE_KEY=<hex>` from your team secrets manager
   instead — the script picks that up over the local file.

3. **Configure GCP Artifact Registry workload identity** (already done
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
```

What the script does, in order:
1. Validates the new version is strictly greater than the current
   `CAELO_VERSION` (from `packages/shared/src/version.ts`).
2. Updates the `CAELO_VERSION` constant.
3. Walks every workspace `package.json` and bumps `"version"` to match.
4. Re-signs every Tier-1 plugin manifest under
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
- **`release-images.yml`** — builds admin + gateway images, tags them,
  signs with cosign, mirrors GHCR → GCP Artifact Registry.

Both bind their artifacts to the same git SHA — the release is
atomic.

### 4. Verify

After both workflows go green:
```bash
npm view @caelo-cms/provisioning version    # → X.Y.Z
docker pull ghcr.io/caelo-cms/admin:X.Y.Z   # → succeeds
gh release view vX.Y.Z                      # → shows the changelog
```

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
