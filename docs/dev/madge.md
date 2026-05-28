# Madge — the circular-dependency gate

[Madge](https://github.com/pahen/madge) is Caelo's automated enforcement layer for the clean-import-graph half of CLAUDE.md §4 ("Small, composable modules. If a file exceeds ~300 lines, consider splitting."). It runs locally via `bun run circular` and in CI via the same command, and gates PR merge.

Madge walks the TypeScript import graph and reports **runtime circular dependencies** — cycles where module A imports a value from module B and B imports a value back from A. Those cycles are a real correctness hazard: at module-init time one side sees the other half-initialized, which surfaces as `undefined`-is-not-a-function crashes that depend on import order and are miserable to debug. The gate is regression-prevention — the baseline today is **0** runtime cycles across ~610 scanned files — so it locks in a clean graph rather than fixing an existing mess.

## Running it

```bash
bun run circular   # madge --circular apps packages
```

On a clean graph it prints `✔ No circular dependency found!` and exits `0`. On a cycle it prints a numbered list (`1) a.ts > b.ts > a.ts`) and exits non-zero — which is exactly what fails the CI step. The same command is both the local check and the CI gate; there is no separate `:strict` variant (madge has no GitHub-Actions reporter, so a second script would buy nothing).

## The `skipTypeImports` decision (the one load-bearing knob)

`.madgerc` sets `detectiveOptions.{ts,tsx}.skipTypeImports = true`. This is the difference between a green gate and a red one on a clean tree, so it is worth understanding.

A `import type { X }` statement is **erased at compile time** under the repo's `verbatimModuleSyntax` setting — it produces no runtime `import`. So a "cycle" made only of `import type` edges cannot deadlock module initialization; it is not a runtime cycle, and counting it would be a false positive.

The live example is `packages/admin-core/src/deploy/static-publisher.ts` and its provider siblings (`static-publisher-gcs.ts`, `-aws.ts`, `-azure.ts`, `-firebase.ts`, `-self-hosted.ts`):

- each provider does `import type { StaticPublisher } from "./static-publisher.js"` — a **type-only** edge, erased at runtime;
- `static-publisher.ts` loads the providers lazily via dynamic `import("./static-publisher-gcs.js")` — which madge does not treat as a static cycle edge.

Without `skipTypeImports`, madge reports 5 cycles here; with it, the count is 0 — correctly, because there is no runtime cycle. The smoke test (`scripts/madge-smoke.test.ts`) encodes this decision: a control run with the knob *off* proves madge can see the type edge, and the main run proves the knob suppresses it. If you ever need to find type-only cycles deliberately, run `bunx madge --circular --ts-config tsconfig.base.json apps packages` without the `.madgerc` knob — but do not wire that into the gate.

## The exclude inventory

`.madgerc#excludeRegExp` keeps non-source and generated paths out of the graph. Madge can't carry inline comments (its rc loader parses strict JSON), so the rationale lives here:

| Pattern | Why |
|---|---|
| `node_modules` | Third-party code; not ours to police. Madge also treats workspace packages resolved through `node_modules` symlinks as external, so cross-package-by-name cycles are out of the detection surface (see below). |
| `dist`, `build` | Compiled output mirrors source; scanning it would double-count and surface phantom cycles in emitted code. |
| `.svelte-kit` | SvelteKit generates `$types.d.ts` ↔ `proxy+page.server.ts` pairs that are inherently circular by design. Without this exclude, madge reports ~96 generated-proxy cycles that no human wrote. |
| `\.test\.ts$` | Test files are leaves, not graph modules; a test importing the thing it tests is not an architectural cycle. |

## What madge will NOT catch

Madge is a static TS-import analyzer. It does **not** detect:

- **`.svelte`-routed cycles.** Madge's TypeScript detective does not parse `.svelte` single-file components, so a cycle that passes *through* a `.svelte` file is invisible. (`fileExtensions` is `["ts","tsx"]`.)
- **Cross-workspace-package cycles addressed by package name** (`@caelo-cms/x` ↔ `@caelo-cms/y`). Workspace packages resolve via `node_modules` symlinks and madge treats them as external; we deliberately do not enable `includeNpm`. The detection surface is relative-import cycles *within* a package's source.
- **Dynamic `import()` of a computed/string specifier.** Madge can't follow `import(someVariable)`. The static-publisher lazy loader uses literal specifiers, which madge *can* see (and which the `skipTypeImports` reasoning above relies on), but a string built at runtime is opaque.

For these classes the contributor still has to think. The reviewer test is the same as knip's: *would a smart human reader of this PR notice the cycle from the diff alone?* If yes, madge's silence is fine.

## Adding a justified exclusion

If madge flags something that is genuinely not a runtime cycle — a generated artifact, or a new framework that emits inherently-circular scaffolding — add a pattern to `.madgerc#excludeRegExp` and document the *why* in this file's exclude inventory and the PR description (the config can't carry comments). Prefer fixing a real cycle at its root (CLAUDE.md §4 — refactor when the shape is wrong) over excluding it; an exclude is for false positives, not for silencing a real architectural problem.

`scripts/madge-config.test.ts` locks the load-bearing fields (the `skipTypeImports` knob, the `.svelte-kit` exclude, the `circular` script string, the exact-pinned madge version), so a config change that would silently weaken the gate fails a test before it merges.
