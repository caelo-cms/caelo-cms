# Developer docs

This directory holds Caelo's **developer docs**: architecture notes, patterns, design decisions, runbooks and maintainer procedures, for contributors and AI agents working in this repo. They change in the same PR as the code they describe.

**End-user docs** (install, upgrade, using the admin, plugins, MCP) live in the CMS at **[caelo-cms.com/docs](https://caelo-cms.com/docs/)**, not here. To change one, see [CONTRIBUTING.md → Documentation](../CONTRIBUTING.md#documentation).

Start with [`ARCHITECTURE.md`](../ARCHITECTURE.md) (system overview) and [`CLAUDE.md`](../CLAUDE.md) (engineering rules). The product spec is [`CMS_REQUIREMENTS.md`](../CMS_REQUIREMENTS.md).

## Architecture and patterns

- [propose-execute-pattern.md](./propose-execute-pattern.md) — the apply + audit engine behind human-approved (gated) AI tools, and how to gate a new domain (CLAUDE.md §11.A).
- [internal-links.md](./internal-links.md) — internal links as page references: write-time canonicalisation, render-time resolution, and why a move rewrites no link (epic #724).
- [lists.md](./lists.md) — lists, list types, page types and sources: the field system, template syntax, resolver, plugin translation hooks and the AI surface (epic #1107).
- [module-type-and-composition.md](./module-type-and-composition.md) — the module `type` column and which modules may fill a nested slot.
- [themes.md](./themes.md) — the theme token document, token roles, the cold-start gate and theme assets.
- [typography-strategy.md](./typography-strategy.md) — the core font service: immutable font registry, licensing, themes and static builds.
- [branch-aware-plugin-storage.md](./branch-aware-plugin-storage.md) — how plugin writes land on a chat's branch instead of live (CMS_REQUIREMENTS §14.7).
- [plugin-live-preview.md](./plugin-live-preview.md) — plugin preview documents shown in Live Edit.
- [plugin-admin-panels.md](./plugin-admin-panels.md) — plugins' admin pages, declared as data and rendered only while the plugin is active.
- [live-edit-references.md](./live-edit-references.md) — right-click / selection references and Ask AI in the Live Edit preview, and what the AI receives.
- [inspect-tooling-redesign.md](./inspect-tooling-redesign.md) — gist-first inspection of external pages and on-demand HTML queries.
- [dev/public-admin-boundary.md](./dev/public-admin-boundary.md) — the public/admin boundary: the public side is assumed compromised.
- [dev/public-admin-read-paths.md](./dev/public-admin-read-paths.md) — every path where the admin reads `cms_public` data, and how each treats it as untrusted.
- [dev/mcp-access.md](./dev/mcp-access.md) — MCP access as one concept: token vs remote chat vs remote admin, who may use which, per-app connections, revoke/restore/block (#968).
- [dev/password-management.md](./dev/password-management.md) — password policy, change, reset and Owner reset in code.
- [internal/bug-intake.md](./internal/bug-intake.md) — how to operate a bug intake (setup, signed image, configuration) that files one GitHub issue per defect.

## AI internals

- [internal/tool-search.md](./internal/tool-search.md) — Anthropic Tool Search: the core tool set and deferred tools.
- [internal/tool-schemas.md](./internal/tool-schemas.md) — the compact model-facing tool schema vs the strict Zod schema at dispatch, and its superset contract.
- [internal/google-models.md](./internal/google-models.md) — Google chat and image model configuration.
- [internal/plugin-author-previews.md](./internal/plugin-author-previews.md) — private plugin preview URLs.
- [internal/plugin-images.md](./internal/plugin-images.md) — the `image_generation` plugin capability.
- [internal/plugin-private-files.md](./internal/plugin-private-files.md) — the `private_files` plugin capability.
- [internal/plugin-site-media.md](./internal/plugin-site-media.md) — the `site_media_read` plugin capability.

## Testing and quality gates

- [internal/e2e-livedit.md](./internal/e2e-livedit.md) — the real-AI Playwright suite: setup, assertion classes, adding a scenario.
- [quality-checks.md](./quality-checks.md) — the quality audit's checks on the staged build (check framework, `structure`, `links`, `references`) and the Stage-time reference-integrity gate (#724).
- [dev/coverage.md](./dev/coverage.md) — the coverage gate.
- [dev/knip.md](./dev/knip.md) — the dead-code gate.
- [dev/madge.md](./dev/madge.md) — the circular-dependency gate.
- [dev/codeql.md](./dev/codeql.md) — CodeQL, dependency review and secret scanning.

## Releases and operations

- [dev/release-manifest.md](./dev/release-manifest.md) — the signed release manifest and the `caelo-ops` image.
- [dev/upgrader-smoke.md](./dev/upgrader-smoke.md) — the real-GCP upgrader smoke test (release gate + post-install verify via Settings → Updates) and its one-time setup.
- [maintainer-public-registry-setup.md](./maintainer-public-registry-setup.md) — one-time setup of the public image registry mirrors.
- [maintainer-ar-cleanup-policy.json](./maintainer-ar-cleanup-policy.json) — the Artifact Registry cleanup (retention) policy.
- [incident-response.md](./incident-response.md) — runbook for triaging and recovering from production incidents.
- [TELEMETRY.md](./TELEMETRY.md) — telemetry policy: off by default, opt-in per category.

Release process: [`RELEASING.md`](../RELEASING.md). Security policy: [`SECURITY.md`](../SECURITY.md).
