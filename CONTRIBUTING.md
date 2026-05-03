# Contributing to Caelo CMS

Thanks for considering a contribution. This document covers everything from "I want to file a bug" to "I want to ship a Tier 1 plugin into core."

The engineering principles every contributor (human or AI-assisted) follows are in **[`CLAUDE.md`](./CLAUDE.md)**. Read that first — it's the authoritative answer to "how should code in this repo look + behave". The architecture overview is in **[`ARCHITECTURE.md`](./ARCHITECTURE.md)**.

This document just covers the contribution mechanics.

## Quick orientation

- **License:** MPL 2.0. Every source file carries `// SPDX-License-Identifier: MPL-2.0`. New files must too — `bun run lint` enforces this.
- **Compatible-license dependencies only:** MPL-2.0, Apache-2.0, MIT, BSD, ISC, 0BSD, CC0-1.0. GPL/AGPL/SSPL block PRs. `bun run license:check` enforces this in CI.
- **Tests run under `bun test`** (Bun's native runner). Don't add Vitest back.
- **TypeScript strict, no `any` without a comment, Zod at every external boundary.** See CLAUDE.md §4.

## Local development loop

You need: [Bun](https://bun.sh) ≥1.3 + Docker (for Postgres) + the [Anthropic API key](https://console.anthropic.com) (for AI features) + [Deno](https://deno.com) ≥2 (for Tier 2 plugin sandbox).

```bash
git clone https://github.com/caelo-cms/caelo-cms.git
cd caelo-cms
cp .env.example .env                  # then add ANTHROPIC_API_KEY
bun install
docker compose up -d                  # postgres + caddy
bun run db:migrate                    # apply both cms_admin + cms_public migrations
bun run --filter @caelo/admin seed:dev  # owner + sample pages
bun run --filter @caelo/admin dev     # admin at http://localhost:5173
```

Verify everything passes locally before opening a PR:

```bash
bun run lint            # biome + audit-callsites + SPDX
bun run typecheck       # tsc -b across the whole workspace
bun test                # unit + integration tests; needs Postgres up
bun run license:check   # transitive license allowlist
```

## What kinds of contributions we want

### Bug reports + small fixes — yes, always

Open an issue using the **Bug** template. If you've already got the fix, open the PR directly and link the issue from the description.

### New Tier 2 plugins (AI-authored OR human-authored)

Tier 2 plugins are sandboxed (Deno subprocess) and AI-authorable. Most plugin contributions will use the AI authoring path — open an issue describing the plugin's purpose, then ask the live-edit chat to draft it. The Owner UI at `/security/plugins` runs the validator + activates after review.

For human-authored Tier 2 plugins: scaffold under `packages/plugins/<slug>/`, declare your schema, your operations, your component, your `staticRender`. Submit via the same `submit_plugin` flow OR open a PR adding the source under `packages/plugins/<slug>/source.ts` + the AI tool will pick it up at install time.

### New Tier 1 plugins (core, signed, in-process)

Tier 1 plugins are core code. They're audited, signed with the Caelo Ed25519 key, and run in-process with full SDK access (cross-`cms_admin` writes, snapshot emission, AI provider, chat-runner tool registration). **Only humans contribute Tier 1 source** — AI cannot edit it.

If you want to land a Tier 1 plugin:

1. Open an issue first — Tier 1 surface is intentionally small. We'll discuss whether your plugin belongs in core or as a Tier 2.
2. If yes: scaffold under `packages/plugins/<slug>/`, declare your `manifest.json` with the capabilities you need, sign it with `bun run plugins:sign`, and open the PR.
3. The PR description must explain: which `requestedCapabilities` you need + why, every cross-`cms_admin` write you do + which existing op it dispatches to, and how disabling your plugin affects the Owner's site.

### Changes to core (chat-runner, Query API, plugin host, provisioning, etc.)

These need an issue first so we can discuss scope. The non-negotiable invariants in CLAUDE.md §2 are not negotiable; if your change touches one, the issue is the place to argue why.

### Documentation contributions

Docs are dogfooded — `caelo-cms.com` is itself a Caelo install whose content lives under `docs-site/` in this repo. Edit the markdown there + open a PR; staging deploys automatically and we promote to production after review.

## Pull request mechanics

- **Conventional commits.** `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`. Scope by phase when applicable: `feat(phase-17): …`.
- **One coherent change per PR.** Mixed unrelated changes are rejected on review — open them separately.
- **Use the PR template.** It asks for *what changed*, *why* (with `CMS_REQUIREMENTS.md` section reference if applicable), *how it was verified*, *new dependencies + their licenses*. The template is at `.github/PULL_REQUEST_TEMPLATE.md`.
- **No `--no-verify`.** No force-push to `main`. No `--no-gpg-sign` workarounds. If a hook is blocking you, fix the underlying issue.
- **Tests with every change.** Bug fixes get a regression test that would have caught the bug. New features get unit + integration + (where user-visible) Playwright E2E coverage. CI blocks merges that drop below declared coverage.

Reviewers check (per CLAUDE.md §9):
- Permission layer respected
- Query API only (no raw SQL)
- Snapshots emitted for every write
- Validation present (Zod at the boundary)
- Tests added
- Docs updated when behaviour is user-visible

## Reporting security issues

**Do NOT open a public issue for a security vulnerability.** See **[`SECURITY.md`](./SECURITY.md)** for the disclosure process — TL;DR: GitHub's Private Vulnerability Reporting on this repo.

## Code of conduct

This project adopts the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md) verbatim. By participating you agree to abide by it.

## License of contributions

By submitting a PR you agree to license your contribution under the same MPL 2.0 as the rest of the project. No CLA, no copyright assignment.
