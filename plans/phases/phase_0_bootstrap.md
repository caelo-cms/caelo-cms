# Phase 0 — Repo bootstrap, tooling & CLAUDE.md

**Status:** ✓ complete (incl. hardening passes 1 & 2) — verified locally and on GitHub Actions. Remote CI run 24909449858 green (26s). Commit: `287699f` on `origin/main`.
**Dependencies:** none (greenfield).
**Unblocks:** P1, P2.

## Goal (from master plan)
Initialise the Bun monorepo with TypeScript (strict), Biome, Zod, Vitest, a root `docker-compose.yml` with PostgreSQL, GitHub Actions CI (typecheck + lint + test), and `CLAUDE.md` at the repo root. Deliverable: `bun install && docker compose up -d && bun test` green on empty scaffold; `CLAUDE.md` reviewed.

## End-to-end verification
`bun install && docker compose up -d && bun test` green on empty scaffold.

## Versions pinned (verified against npm registry, latest confirmed working)

| Tool | Version | Source |
|---|---|---|
| Bun (runtime + package manager) | 1.3.13 | github.com/oven-sh/bun latest release |
| TypeScript | 6.0.3 | npm registry `latest` (verified compatible with Biome 2.4.13 + `@types/bun` 1.3.13 + project-references build) |
| @biomejs/biome | 2.4.13 | npm registry `latest` |
| Zod | 4.3.6 | npm registry `latest` |
| Vitest | 4.1.5 | npm registry `latest` |
| @types/bun | 1.3.13 | npm registry `latest` |
| license-checker-rseidelsohn | 4.4.2 | npm registry `latest` (Apache-2.0) |
| PostgreSQL image | `postgres:17-alpine` | Docker Hub |

## Files created

```
/Users/michaelweber/Projects/caleo-cms/
├── .editorconfig
├── .github/workflows/ci.yml
├── .gitignore
├── CLAUDE.md                         # Full engineering principles (§1–11 from master plan)
├── CMS_REQUIREMENTS.md               # (pre-existing, v1.3)
├── LICENSE                           # MPL 2.0 full text
├── README.md                         # Quickstart
├── biome.json                        # Biome 2.x config
├── docker-compose.yml                # postgres:17-alpine + healthcheck
├── package.json                      # workspaces root, dev deps, scripts
├── tsconfig.base.json                # strict TypeScript base config
├── tsconfig.json                     # solution file, references all workspaces
├── vitest.config.ts                  # Vitest root config
├── apps/
│   ├── admin/                        # SvelteKit admin (scaffold only)
│   ├── api-gateway/                  # Bun HTTP gateway (scaffold only)
│   └── static-generator/             # Astro static gen (scaffold only)
└── packages/
    ├── migrations/                   # (empty, populated in P1)
    ├── plugin-sdk/                   # Plugin SDK (scaffold only)
    ├── provisioning/                 # Pulumi (scaffold only)
    ├── query-api/                    # Query API (scaffold only)
    └── shared/                       # Zod/shared types + placeholder test
```

Every workspace has: `package.json` (name `@caelo/<slug>`, `license: MPL-2.0`, `type: module`, `typecheck` script), `tsconfig.json` extending the base with `composite: true` + appropriate `references`, and an `src/index.ts` placeholder carrying the SPDX header.

`packages/shared/src/index.test.ts` is the seed test that makes `bun test` meaningful on the empty scaffold.

## How to verify locally

```bash
cd /Users/michaelweber/Projects/caleo-cms

# If Bun is not installed:
curl -fsSL https://bun.sh/install | bash

bun install
docker compose up -d
bun run lint
bun run typecheck
bun run test
```

All three commands should pass. The GitHub Actions workflow in `.github/workflows/ci.yml` runs the same three commands against a PostgreSQL 17 service container on every push + PR.

## Verified outcomes

| Check | Result |
|---|---|
| `bun install` | 140 packages installed, clean lockfile |
| `docker compose up -d` | `caelo-postgres` healthy on :5432 via `env_file` |
| `bun run lint` | 27 files checked, 0 issues |
| `bun run typecheck` | `tsc -b` clean across all 7 workspace project references |
| `bun run test` | 1 file / 1 test passing |
| `bun run license:check` | all transitive deps on the MPL-2.0-compatible allowlist |

## Hardening passes (applied 2026-04-24)

**Pass 2** (adopted after review):

5. **Lockfile freshness gate in CI.** Dedicated `lockfile` job runs before the main `check` job: `bun install` (no `--frozen-lockfile`) then `git diff --exit-code` against `bun.lock` + all `package.json` files. Fails with *"run 'bun install' locally and commit the resulting bun.lock"* if anyone bumps a version without regenerating the lockfile.
6. **Drop Vitest, adopt `bun test`.** Removed `vitest` + `vitest.config.ts`; seed test imports from `bun:test`; ~40 transitive deps dropped. CLAUDE.md §6 gains a one-liner forbidding Vitest re-adds. Per-workspace tsconfigs now `exclude` test files from compilation so compiled artifacts never double-discover under `dist/`.

**Pass 1** — four follow-ups that should not wait for P1:

1. **Secrets hygiene.** `docker-compose.yml` no longer hardcodes credentials — all three Postgres env vars (`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`) come from `.env` via `env_file`. `.env.example` is committed as the template; `.env` is gitignored (`!.env.example` negation keeps the template visible). CI workflow sets the same variables inline under `env:` since CI test creds are workflow-scoped, not committed secrets.
2. **Project references are now functional.** Root `typecheck` is `tsc -b` using the solution `tsconfig.json` + per-workspace `composite` projects. Incremental build caching via `.tsbuildinfo` (gitignored). Per-workspace `typecheck` scripts are `tsc -b` too so `cd packages/shared && bun run typecheck` also builds incrementally.
3. **License check runs in CI.** New `license:check` script runs `license-checker-rseidelsohn` against the production dep tree with an `--onlyAllow` allowlist of MPL-2.0-compatible licenses (MPL-2.0, Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, CC0-1.0, Unlicense, Python-2.0, BlueOak-1.0.0). CI step added after test. A GPL/AGPL/SSPL dep will fail the job mechanically — no reviewer-trust required.
4. **TypeScript 6.0.3.** Bumped from 5.9.3 — verified compatible with Biome 2.4.13, `@types/bun` 1.3.13, and project-references build mode.

Two small scaffold fixes recorded for any future regeneration:

- Biome 2.2+ dropped the trailing `/**` in folder-ignore globs — patterns are now `!**/dist` not `!**/dist/**`.
- Internal relative test imports must use `./index.js` (or no extension), not `./index.ts`, unless `allowImportingTsExtensions` is enabled — we keep it disabled so emitted declarations resolve cleanly.

## Known follow-ups (for P1+)

- `packages/migrations/` is empty by design — migration tooling choice (drizzle-kit vs Atlas) is a P1 decision.
- `apps/admin/` is a stub; SvelteKit + svelte-adapter-bun install is a P2 task.
- `apps/static-generator/` is a stub; Astro install is a P6 task.
