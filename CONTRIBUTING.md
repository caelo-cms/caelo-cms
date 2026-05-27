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
bun run --filter @caelo-cms/admin seed:dev  # owner + sample pages
bun run --filter @caelo-cms/admin dev     # admin at http://localhost:5173
```

Verify everything passes locally before opening a PR:

```bash
bun run lint            # biome + audit-callsites + SPDX
bun run typecheck       # tsc -b across the whole workspace
bun test                # unit + integration tests; needs Postgres up
bun run knip            # dead-code gate — unused files / exports / deps (see docs/dev/knip.md)
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

- **All changes to `main` go through a pull request.** Direct pushes, force pushes, and branch deletion are rejected by the `main-protection` ruleset on the GitHub repo. The ruleset's source-of-truth lives in `.github/rulesets/main.json` and is applied by `bun run rulesets:apply` (maintainers only). Edit the JSON via PR — do not edit the ruleset in the GitHub UI; the next apply run reverts it. Run `bun run rulesets:check` to confirm the live state matches the committed spec.
- **Conventional commits.** `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`. Scope by phase when applicable: `feat(phase-17): …`.
- **One coherent change per PR.** Mixed unrelated changes are rejected on review — open them separately.
- **Use the PR template.** It asks for *what changed*, *why* (with `CMS_REQUIREMENTS.md` section reference if applicable), *how it was verified*, *new dependencies + their licenses*. The template is at `.github/PULL_REQUEST_TEMPLATE.md`.
- **No `--no-verify`.** No force-push to `main`. No `--no-gpg-sign` workarounds. If a hook is blocking you, fix the underlying issue.
- **Required CI checks must pass before merge.** The ruleset requires `Lockfile freshness`, `Lint, Typecheck, Migrate, Test, License` (the latter rolls up Biome lint + SPDX + audit-callsites, version lockstep, tsc, `bun test`, and MPL-2.0 license compatibility), `build + push (admin)` + `build + push (gateway)` (the matrix jobs of the `release-images` workflow — these catch regressions that only surface in the lean production Docker image, the same class of bug as #53), and `Admin production image — boot smoke` (the `admin-prod-image` job in `ci.yml` — builds the admin Dockerfile and `docker run`s it to confirm the server actually boots, catching `Cannot find module`-class regressions that succeed at build time but crash on `docker run`). The branch must be up to date with `main` and all review threads resolved before merge. Squash or rebase only — no merge commits.
- **Tests with every change.** Bug fixes get a regression test that would have caught the bug. New features get unit + integration + (where user-visible) Playwright E2E coverage. CI blocks merges that drop below declared coverage.

### AI security review

Every PR is reviewed by an automated AI security pass — the workflow is at `.github/workflows/security-review.yml` and runs Anthropic's [`claude-code-security-review`](https://github.com/anthropics/claude-code-security-review) action. It posts a summary comment plus inline comments on findings, typically within ~3 minutes of PR open.

The review is **informational, not blocking** — human reviews remain required for merge. Findings cite the rule they violate (e.g. *"violates CLAUDE.md §2 invariant: raw SQL detected"*); address each one in your next push, or rebut in the PR discussion. When an inline comment doesn't render but the workflow ran, the raw `findings.json` + error log live on the workflow run's `security-review-results` artifact (7-day retention) — open the Actions tab on the PR.

The review is skipped (and no Claude call is made) when:
- the PR author is a bot (Dependabot — see *"Dependabot review conventions"* below — or Renovate, if it ever lands as the alternative),
- the PR is in Draft state,
- the PR carries the `skip-ai-review` label, or
- the PR changes more than 200 files (token-spend guard — split the PR, or add the `skip-ai-review` label if the large diff is intentional).

Reviewers check (per CLAUDE.md §9):
- Permission layer respected
- Query API only (no raw SQL)
- Snapshots emitted for every write
- Validation present (Zod at the boundary)
- Tests added
- Docs updated when behaviour is user-visible

### Dependabot review conventions

Dependabot is configured at `.github/dependabot.yml` and opens PRs for three ecosystems: workspace JS (Bun), GitHub Actions, and Docker base images. The config (and a unit test that locks its shape at `scripts/dependabot-config.test.ts`) is the source of truth for these conventions — this section just orients reviewers.

- **Label + commit prefix.** Every Dependabot PR carries the `dependencies` label and a `chore(deps)` (or `chore(deps-dev)`) commit subject. Filter your queue with `gh pr list --label dependencies`.
- **Cadence.** Routine version bumps land in one grouped PR per workspace per week, opened Monday around 06:00 UTC. Major version bumps stay one-PR-each so each breaking change gets a focused review. Security PRs are individual and fire immediately when an advisory lands — they bypass the weekly schedule and the 3-day cooldown.
- **Rebase, don't push.** If a Dependabot PR has a stale base, comment `@dependabot rebase` on the PR. Don't push local commits onto a `dependabot/...` branch — Dependabot will overwrite them on the next rebase tick.
- **Reviewing the diff.** Read the changelog / release notes link in the PR description. For majors, ask: is the breaking change one we hit? For minor + patch groups, the diff is usually a `package.json` + `bun.lock` change; the existing CI gates (`Lint, Typecheck, Migrate, Test, License` + `Lockfile freshness` + the two image jobs + the boot smoke) catch the regressions you would otherwise have to look for by hand. A green CI on a Dependabot PR is a strong signal.
- **Closing without merging.** If you want to skip a specific bump, comment `@dependabot ignore this minor version` (or `major`, or `dependency`) on the PR. Closing the PR without an ignore directive will not stop Dependabot from re-opening the same bump next week.
- **Toggling.** "Security advisories trigger an immediate PR" depends on the repo-level *Dependabot security updates* setting at `https://github.com/caelo-cms/caelo-cms/settings/security_analysis`. Maintainers can probe its state with `gh api /repos/caelo-cms/caelo-cms/automated-security-fixes`.

## Reporting security issues

**Do NOT open a public issue for a security vulnerability.** See **[`SECURITY.md`](./SECURITY.md)** for the disclosure process — TL;DR: GitHub's Private Vulnerability Reporting on this repo.

## Code of conduct

This project adopts the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md) verbatim. By participating you agree to abide by it.

## License of contributions

By submitting a PR you agree to license your contribution under the same MPL 2.0 as the rest of the project. No CLA, no copyright assignment.
