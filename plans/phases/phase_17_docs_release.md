# Phase 17 — Docs, OSS release prep

**Status:** stub — detail to be filled when this phase is picked up.
**Dependencies:** all prior phases.

## Goal (from master plan)
Apache 2.0 LICENSE, CONTRIBUTING.md, security policy, docs site at caelo-cms.com built with Caelo itself (dogfooding). Public release to github.com/caelo-cms. Quickstart (`bunx cms-provision --provider self-hosted`), admin walkthrough, plugin authoring guide, provisioning runbook per provider.

## End-to-end verification
Docs site builds from Caelo itself; `git clone && bunx cms-provision --provider self-hosted` produces a working install per README.

## To be detailed before execution
- LICENSE (Apache 2.0).
- CONTRIBUTING.md: code of conduct, PR checklist (aligned with CLAUDE.md §9), dev setup.
- SECURITY.md: responsible disclosure, scope, response expectations.
- Docs site content plan: quickstart, concepts (permission model, snapshots, modules), admin guide, plugin SDK reference, provisioning runbook per provider, i18n guide, troubleshooting.
- Dogfooding: docs site is a Caelo install; every page authored via the admin; site source checked into repo as a Pulumi stack + snapshot seed.
- Release checklist: CVE/secret scan, license audit of dependencies, LICENSE headers on source files, CHANGELOG, tagged release, announcement.
