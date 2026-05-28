# Knip — the dead-code gate

[Knip](https://knip.dev) is Caelo's automated enforcement layer for CLAUDE.md §5 ("No dead code. Delete it; git remembers."). It runs locally via `bun run knip` and in CI via `bun run knip:strict`, and gates PR merge.

Knip detects three classes of dead code that manual review at 500+ TypeScript files can't reliably find:

1. **Unused files** — TypeScript modules not reachable from any declared entry point.
2. **Unused exports** — exported symbols (functions, types, classes) with no consumers across the workspace.
3. **Unused dependencies** — entries in `package.json#dependencies` / `devDependencies` that no source file imports.

It also flags unlisted dependencies (imports without a corresponding `package.json` entry) and duplicate exports (the same value exported under two names).

## Running it

```bash
bun run knip          # local check — default mode, table reporter, exit 0 on green
bun run knip:strict   # CI invocation — github-actions reporter (inline PR annotations)
bun run knip:fix      # auto-delete the safe findings (unused exports, unused files)
```

### Safe `knip:fix` workflow

`knip:fix` mutates the working tree by deleting unused exports + unused files in place. The contract for using it safely:

1. **Start from a clean working tree.** `git status` must be empty so the fix's diff is unambiguous.
2. **Run `bun run knip:fix`.** Knip rewrites source files in place.
3. **Review the diff with `git diff`.** Knip's static analysis can't see dynamic-load patterns (files invoked via Pulumi CLI, Bun's `import.meta.glob`, DB-resident Tier 2 plugin source). When `--fix` deletes something dynamically loaded, the loss only surfaces at runtime — catch it here, not in production.
4. **Run `bun run typecheck` + `bun test`.** If anything was dynamically loaded and knip got it wrong, the type-check or test will fail.
5. **Stage + commit.** Use a `refactor:` Conventional Commit subject so the cleanup is discoverable in `git log`.

If step 3 surfaces a deletion that should NOT happen, revert with `git restore` and add the offending path to `knip.json#ignore` (with a follow-up issue tracking the false positive — knip can't read JSON comments).

## A note on the `:strict` suffix

The `knip:strict` script does NOT pass knip's `--strict` flag — that flag means "production-only analysis" in knip's vocabulary (excludes `devDependencies`, excludes test files, includes only `peerDependencies`), which is too aggressive for a monorepo where e2e helpers, migration tooling, and dev scripts legitimately live outside the production tree. The script name is preserved per the original issue (#12) for muscle memory; the CI invocation is default-mode knip with the GitHub Actions reporter for inline annotations.

If you encounter knip docs referring to `--strict` and wonder why we omit it: see [knip.dev/reference/cli](https://knip.dev/reference/cli) — `--strict` implies `--production`, which is not what we want.

## Adding a justified ignore

If knip flags something that's *not* dead — typically a dynamically-loaded entry point or an export consumed by a non-JS surface (a YAML workflow, a `.mcp.json`, a Pulumi stack) — add the ignore to `knip.json` at the repo root.

`knip.json` is **strict JSON** (no comments). When you add an ignore, document the *why* in the PR description and link to a follow-up issue if the ignore is temporary. The shape:

```jsonc
// in knip.json
{
  "ignoreDependencies": ["@playwright/mcp"],      // referenced by .mcp.json, invisible to knip
  "ignore": ["path/to/dynamically-loaded.ts"],    // entry point loaded by external tooling
  "ignoreIssues": {
    "path/to/file.ts": ["exports", "types"]       // selectively suppress per-file categories
  }
}
```

Categories accepted by `ignoreIssues`: `files`, `dependencies`, `devDependencies`, `unlisted`, `binaries`, `exports`, `types`, `nsExports`, `nsTypes`, `enumMembers`, `classMembers`, `duplicates`, `unresolved`, `optionalPeerDependencies`. See [knip.dev/reference/configuration](https://knip.dev/reference/configuration) for the authoritative list.

## Current ignore inventory

`knip.json` is strict JSON and can't carry inline comments, so the rationale for every current ignore lives here. Two kinds: **permanent** (a real false positive knip can't resolve) and **temporary** (deferred to the issue #22 cleanup — remove the entry when the underlying item is fixed).

### `ignore` (whole-file)

| Path | Kind | Why |
|---|---|---|
| `apps/admin/e2e-livedit/lib/build-stats.ts` | Temporary (#22) | Live-edit e2e helper not yet wired to a scenario. |
| `apps/admin/src/lib/components/ui/sheet/**` | Temporary (#22) | shadcn-svelte Sheet component generated but not yet placed in a route. |
| `packages/migrations/src/rls.ts` | Temporary (#22) | RLS helper reachable only from migration tooling; needs an entry-point review. |
| `packages/migrations/src/schema/cms_admin/rate_limits.ts` | Temporary (#22) | Schema table not yet referenced by a Query API op. |
| `packages/provisioning/stacks/aws/edge-handler-bundle.js` | Permanent | Deploy-time placeholder, replaced by `build:edge-aws` at deploy. Never imported by source. |

### `ignoreBinaries`

| Binary | Kind | Why |
|---|---|---|
| `cms-provision` | Permanent | Referenced in `.github/workflows/release.yml`; the bin is published by `packages/provisioning`, invisible to knip's per-workspace binary resolution. |

### `ignoreDependencies`

| Dependency | Kind | Why |
|---|---|---|
| `@playwright/mcp` | Permanent | Invoked via `.mcp.json` (`bunx @playwright/mcp`), a non-JS config knip can't parse. |
| `@caelo-cms/shared` | Temporary (#22) | Declared but not imported in `apps/api-gateway`, `packages/plugin-sandbox`, `packages/plugin-sdk` — needs a per-package review before removal (the dep may be load-bearing for type resolution in a way grep doesn't show). |

### `ignoreIssues` (per-file, per-category)

Most `ignoreIssues` entries are **temporary (#22)** — exports/types kept for their public-API shape but not yet consumed; the cleanup pass under #22 will delete the unused symbol and remove the corresponding entry. Two `duplicates` entries are **permanent**, suppressing intentional aliases rather than real duplication:

- `packages/shared/src/subagents.ts` — `spawnSubagentToolInput` is a readability alias for `subagentSpec` (both names are consumed externally).
- `packages/shared/src/version.ts` — `CALEO_VERSION` is a `@deprecated` typo-alias for `CAELO_VERSION`, kept for external consumers of the published `@caelo-cms/shared` package until the next major bump.

## What knip won't catch

Knip is a static analysis tool. It does NOT detect:

- **Unused class methods** — by design, class members aren't in the default analysis surface (the `pruneSha` orphan was found by manual audit, not knip).
- **Unused database columns / tables** — these are runtime data, not code.
- **Plugin source loaded from the database** — Tier 2 plugin code lives in `plugins.source_code` rows, not on disk.
- **Dynamic invocations via `eval` / `new Function`** — Caelo doesn't use these, but if you add one, knip can't follow it.

For these classes, the contributor still has to think. The reviewer test is: *would a smart human reader of this PR notice that the deleted symbol is dead, given the diff alone?* If yes, knip's silence is fine; if no, document the dynamic load path.

## The follow-up cleanup queue

When this gate first landed (issue #12), the codebase had ~30 findings beyond the ones fixed in that PR — a mix of unused files in `packages/migrations/src/`, unused workspace cross-references (`@caelo-cms/shared` declared but not imported in three packages), and exports kept for their public-API shape but not yet consumed. Those are tracked under issue #22's broader cleanup pass; the entries in `knip.json#ignore` and `knip.json#ignoreIssues` referencing those paths are temporary and should be removed as #22 progresses.

If you delete an item that was suppressed by a knip ignore, also remove the ignore in the same PR — leaving stale ignores defeats the gate.
