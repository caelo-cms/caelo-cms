# Caelo end-user docs: CMS seed

This branch (`docs/cms-seed`) is the **seed source for the end-user docs on [caelo-cms.com/docs](https://caelo-cms.com/docs/)**. It is never merged into `main`. End-user docs live in the Caelo CMS; developer docs stay in the main repo (epic [#825](https://github.com/caelo-cms/caelo-cms/issues/825), this branch: [#826](https://github.com/caelo-cms/caelo-cms/issues/826)).

The release docs-sync workflow ([#827](https://github.com/caelo-cms/caelo-cms/issues/827)) reads this branch in its `seed` mode and drafts the pages onto a chat branch of caelo-cms.com. **Nothing here is published automatically:** the Owner reviews the draft and publishes by click.

## Layout

One directory, `seed/`, one Markdown file per page. Each file starts with YAML frontmatter:

```yaml
---
path: /docs/install/self-hosted/   # target URL path on caelo-cms.com
title: "Install: self-hosted"      # page title
description: ...                   # meta description (every page has one)
---
```

The body is plain Markdown. Internal links already use the target paths (`/docs/...`), so they resolve once every page exists.

## Pages

| File | Target path | Title | On the live site today |
|---|---|---|---|
| `seed/index.md` | `/docs/` | Caelo documentation | yes |
| `seed/quickstart.md` | `/docs/quickstart/` | Quickstart | yes |
| `seed/install-self-hosted.md` | `/docs/install/self-hosted/` | Install: self-hosted | yes |
| `seed/install-google-cloud.md` | `/docs/install/google-cloud/` | Install: Google Cloud | yes |
| `seed/admin.md` | `/docs/admin/` | Using the admin | yes |
| `seed/passwords.md` | `/docs/admin/passwords/` | Passwords | new |
| `seed/live-edit.md` | `/docs/live-edit/` | The live-edit overlay | yes |
| `seed/staging-access.md` | `/docs/publishing/staging-access/` | Protected staging | new |
| `seed/quality-gate.md` | `/docs/quality-gate/` | The quality gate | yes |
| `seed/error-pages.md` | `/docs/error-pages/` | Error pages (404) | new |
| `seed/multilingual.md` | `/docs/multilingual/` | Multilingual sites | yes |
| `seed/mcp.md` | `/docs/mcp/` | Talk to Caelo from your IDE (MCP) | yes |
| `seed/plugins-build.md` | `/docs/plugins/build/` | Build a plugin | yes |
| `seed/plugins-permissions.md` | `/docs/plugins/permissions/` | Plugin permissions | yes |
| `seed/consent-and-tracking.md` | `/docs/consent-and-tracking/` | Consent and tracking | new |
| `seed/visitor-privacy.md` | `/docs/visitor-privacy/` | Visitor cookies and consent | new |
| `seed/architecture.md` | `/docs/architecture/` | Architecture | yes |
| `seed/security.md` | `/docs/security/` | Security policy | new |
| `seed/changelog.md` | `/docs/changelog/` | Changelog | yes |

19 pages. "On the live site today" was checked against the live `/docs/` navigation on 2026-10-17; "new" pages do not exist there yet.

Live pages without a seed file (written directly in the CMS, keep them): `/docs/install/` (install overview), `/docs/install/maintenance/` (updates and maintenance; its content overlaps the "Upgrading" and operations sections of the two install pages here, so merge rather than duplicate), `/docs/plugins/` (plugins overview), `/docs/publishing/` (drafts, staging, publishing), `/docs/migrate/` (moving an existing site). Product code links to `/docs/install/`, `/docs/install/maintenance/`, `/docs/mcp/` and `/docs/plugins/permissions/`; those paths must keep resolving.

## Where the content comes from

- `docs-site/pages/` as of `6fff9c71^`, the parent of the commit that retired `docs-site/` ([#787](https://github.com/caelo-cms/caelo-cms/pull/787)). The docs-site edits the maintainer recorded as lost in #787 (gateway without a `cms_admin` login, rolling back to an earlier release, `owner-reset` audit, MCP server `@latest` handshake, quality-gate CPU calibration and five-run median, Cloud Shell pins) were already part of that commit; they are all in these pages.
- The end-user files formerly in `docs/` on `main`: `consent-and-tracking.md`, `error-pages.md`, `password-management.md` (as `passwords.md`, rewritten for users; the implementation notes stay in the main repo as `docs/dev/password-management.md`).

Changed on the way in, so the seed does not bring back claims #787 removed from the README:

- No page claims AWS or Azure installs work: `install-aws.md` and `install-azure.md` were dropped, provider lists name `self-hosted`, `gcp`, `gcp-firebase`, and AWS/Azure rows were removed from tables.
- Cloud SQL high availability is described as off by default (`cloudSqlHa`), with the default `db-f1-micro` tier in the cost example.
- The home page became the `/docs/` landing page, without the `v0.1.0` status, the `claude mcp add --command` snippet (the install's `/settings/mcp` prints the exact command) and the "one-click GCP / AWS / Azure" description.
- The changelog page no longer carries the `v0.1.0` release list ("five core plugins", four provisioning adapters); it points to the in-product release notes and `CHANGELOG.md`.
- Links to the old docs-site slugs (`/install-gcp`, `/plugins-build`, …) were rewritten to the `/docs/...` paths above.
- Dropped as not end-user content: `docs-site/import.json` and `docs-site/structured-sets/` (the old importer's site skeleton; caelo-cms.com has its own theme and menus).

## Version-pinned content

The Google Cloud "Open in Cloud Shell" links pin a release branch of [`caelo-cms/install`](https://github.com/caelo-cms/install) (`cloudshell_git_branch=release-v<version>`), here `release-v0.10.52`, in `index.md`, `quickstart.md` and `install-google-cloud.md`. `scripts/release.ts` moves the pins only in repo files (the main `README.md`); on caelo-cms.com each release's docs-sync draft must move them.
