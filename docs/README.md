# Developer docs

This directory holds Caelo's **developer docs**: architecture notes, patterns, design decisions, runbooks and maintainer procedures, for contributors and AI agents working in this repo. They change in the same PR as the code they describe.

**End-user docs** (install, upgrade, using the admin, plugins, MCP) live in the CMS at **[caelo-cms.com/docs](https://caelo-cms.com/docs/)**, not here. To change one, see [CONTRIBUTING.md → Documentation](../CONTRIBUTING.md#documentation).

Start with [`ARCHITECTURE.md`](../ARCHITECTURE.md) (system overview) and [`CLAUDE.md`](../CLAUDE.md) (engineering rules). The product spec is [`CMS_REQUIREMENTS.md`](../CMS_REQUIREMENTS.md).

## Architecture and patterns

- [dev/state-and-changes.md](./dev/state-and-changes.md) — the state and change contract: one entity change journal written by table triggers, cursors and wake-ups, rebuildable derived state, request-scoped ops, and how plugins consume changes (#1267).
- [propose-execute-pattern.md](./propose-execute-pattern.md) — the apply + audit engine behind human-approved (gated) AI tools, and how to gate a new domain (CLAUDE.md §11.A).
- [dev/build-memory.md](./dev/build-memory.md) — how Stage and Publish live keep memory flat: page batches, media and fonts referenced by stored digest, streamed uploads, parity digests taken while writing (#1271).
- [dev/redirects-and-settings-sync.md](./dev/redirects-and-settings-sync.md) — redirects sync to the hosting provider on save (no build), per provider; which global settings live at the provider and which go live with Publish live (#1157).
- [internal-links.md](./internal-links.md) — internal links as page references: write-time canonicalisation, render-time resolution, and why a move rewrites no link (epic #724).
- [lists.md](./lists.md) — lists, list types, page types and sources: the field system, template syntax, resolver, plugin translation hooks and the AI surface (epic #1107).
- [module-type-and-composition.md](./module-type-and-composition.md) — the module `type` column and which modules may fill a nested slot.
- [themes.md](./themes.md) — the theme token document, token roles, the cold-start gate and theme assets.
- [typography-strategy.md](./typography-strategy.md) — the core font service: immutable font registry, licensing, themes and static builds.
- [branch-aware-plugin-storage.md](./branch-aware-plugin-storage.md) — how plugin writes land on a chat's branch instead of live (CMS_REQUIREMENTS §14.7).
- [plugin-indexes.md](./plugin-indexes.md) — plugin table indexes: the manifest's `indexes`, the automatic ones, which reads the host refuses, names and evolution across versions (#1292).
- [plugin-public-surface.md](./plugin-public-surface.md) — what a visitor can reach of a plugin: public operations as contracts (input, captcha bound to the operation, rate limit, tables), table kinds and the grants generated from them, `requires: ["email"]`, and approval bound to the manifest (#1332).
- [plugin-live-preview.md](./plugin-live-preview.md) — plugin preview documents shown in Live Edit.
- [plugin-admin-panels.md](./plugin-admin-panels.md) — plugins' admin pages, declared as data and rendered only while the plugin is active.
- [plugin-editor-toolbar.md](./plugin-editor-toolbar.md) — plugin places in the live editor's top bar (`editorToolbar`), declared as data, read-only on the chat's draft.
- [plugin-baked-data.md](./plugin-baked-data.md) — how visitor plugin data (comments, ratings) reaches the static HTML through plugin-data builds that publish nothing else (#1155), and how a plugin declares `bakedData`.
- [live-edit-references.md](./live-edit-references.md) — right-click / selection references and Ask AI in the Live Edit preview, and what the AI receives.
- [inspect-tooling-redesign.md](./inspect-tooling-redesign.md) — gist-first inspection of external pages and on-demand HTML queries.
- [dev/rls-and-the-planner.md](./dev/rls-and-the-planner.md) — how row-level security changes plans: write setting tests as `caelo_setting_is` / `caelo_setting_in` (a plain `current_setting(...) = 'x'` policy is estimated at 0.5 % of the rows), and why `ILIKE '%q%'` can never use an index under RLS (#1297).
- [dev/public-admin-boundary.md](./dev/public-admin-boundary.md) — the public/admin boundary: the public side is assumed compromised.
- [dev/database-tls.md](./dev/database-tls.md) — verify-full TLS to the database on every provider: hosts, CA bundles, the self-hosted CA, the upgrade path (#1338).
- [visitor-privacy.md](./visitor-privacy.md) — what a visitor's browser stores and sends to the API gateway: the one `__session` cookie and its entries, the consent decision in the `x-caelo-consent` header, when a visitor id exists, cookies from before #1343.
- [dev/firebase-hosting-behaviour.md](./dev/firebase-hosting-behaviour.md) — what Firebase Hosting does to requests on their way to the gateway, measured on a live gcp-firebase install: only `__session` arrives, `X-Forwarded-For` and the client address, the 60 s rewrite cut and its GET retries, domain-mapping regions (#1325).
- [dev/public-admin-read-paths.md](./dev/public-admin-read-paths.md) — every path where the admin reads `cms_public` data, and how each treats it as untrusted.
- [dev/gateway-hardening.md](./dev/gateway-hardening.md) — the API gateway's own protection without a WAF: the input filter before the database, in-memory limits per client and per operation, live-origin rule, opaque errors, keyed IP hashes, database limits on `public_role`, batched GC (#1326, #1338).
- [dev/mcp-access.md](./dev/mcp-access.md) — MCP access as one concept: token vs remote chat vs remote admin, who may use which, per-app connections, revoke/restore/block (#968).
- [dev/password-management.md](./dev/password-management.md) — password policy, change, reset and Owner reset in code.
- [dev/capture-job.md](./dev/capture-job.md) — server-side screenshots and page renders outside the admin: the GCP capture job, the signed hand-over of a branch preview, the one-at-a-time in-process browser on self-hosted installs (#1217).
- [dev/connection-budget.md](./dev/connection-budget.md) — how every pool's size derives from the server's `max_connections`: the named reserves (gateway, generator, jobs, the #1267 LISTEN connection), the per-adapter numbers, why pools are not just raised (#1254).
- [dev/live-refresh.md](./dev/live-refresh.md) — how the editor stays current without timer polling: live topics over the chat stream and `/api/live-events`, the client hub, adding a live surface (#1215).
- [dev/ai-tool-texts.md](./dev/ai-tool-texts.md) — what stays in an AI tool description and what lives only in the error; the AI-facing error shape (`errors[]` with absolute paths, `failureKind`, no resend wording, no Postgres internals) (#1277); kept failed calls fixed with `retry_tool_call` (#1275).
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
- [dev/scale-gate.md](./dev/scale-gate.md) — the scale gate: 50,000 pages, 20 MCP agents and 5 editors on a db-f1-micro and a 1-vCPU admin; fixture, load, SLOs, running it locally (#1267).
- [dev/query-index-gate.md](./dev/query-index-gate.md) — the query index gates: the seq-scan plan gate over the integration tier (op-tagged transactions, `enable_seqscan=off` + auto_explain, stream filter, allowlist) and the FK index lint; reading a failure, index vs. allowlist entry (#1293).
- [dev/knip.md](./dev/knip.md) — the dead-code gate.
- [dev/madge.md](./dev/madge.md) — the circular-dependency gate.
- [dev/codeql.md](./dev/codeql.md) — CodeQL, dependency review, secret scanning, action SHA pinning and the security-settings drift guard.

## Releases and operations

- [dev/service-images.md](./dev/service-images.md) — minimal service images (the gateway, #1327): a Bun bundle on a digest-pinned distroless base, non-root, no shell, allowlisted content, bundle SBOM and licences, the Trivy gate and boot smoke, and how to add one.
- [dev/release-manifest.md](./dev/release-manifest.md) — the signed release manifest and the `caelo-ops` image.
- [dev/upgrader-smoke.md](./dev/upgrader-smoke.md) — the real-GCP upgrader smoke test (release gate + post-install verify via Settings → Updates) and its one-time setup.
- [maintainer-public-registry-setup.md](./maintainer-public-registry-setup.md) — one-time setup of the public image registry mirrors.
- [maintainer-ar-cleanup-policy.json](./maintainer-ar-cleanup-policy.json) — the Artifact Registry cleanup (retention) policy.
- [incident-response.md](./incident-response.md) — runbook for triaging and recovering from production incidents.
- [TELEMETRY.md](./TELEMETRY.md) — telemetry policy: off by default, opt-in per category.

Release process: [`RELEASING.md`](../RELEASING.md). Security policy: [`SECURITY.md`](../SECURITY.md).
