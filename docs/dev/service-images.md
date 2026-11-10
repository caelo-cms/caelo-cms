# Minimal service images

A service that takes untrusted traffic gets a minimal image: the API gateway today (issue #1327), the MCP auth proxy next. After a remote code execution, every package the service does not use and every shell is attack surface (CLAUDE.md §11.B Tier 3). The admin image is not minimal: it runs the generator, Lighthouse and the full plugin host.

## What a minimal image is

- **A bundle, not the monorepo.** The server's entry points are bundled with Bun (target `bun`, ESM, shared chunks). The gateway's bundle is about 4 MB; its old image carried about 1.2 GB of `node_modules`.
- **Only the packages loaded from disk.** Some code cannot be bundled or must exist as files: native bindings (oxc-parser), and packages that code loaded at run time imports. The image stages exactly their dependency closure, and nothing else.
- **A distroless base, pinned by digest.** No shell, no package manager. Every `FROM` is pinned by digest, and Dependabot (docker ecosystem) proposes the bumps.
- **A non-root user.** `USER 65532:65532`, the distroless `nonroot` user. The app files belong to root, so the service cannot change them.
- **Allowlisted content.** CI fails when the image adds any file to its base that the spec does not list.

## The pieces

| File | Role |
|---|---|
| `scripts/service-image.ts` | `stage` builds the app tree in the Dockerfile's builder stage. `verify` checks a built image in CI. |
| `apps/<service>/image.ts` | The spec: entry points, externals, run-time packages, the exact staged `node_modules`, extra files, binaries, required paths. |
| `apps/<service>/Dockerfile` | The builder installs and builds the workspace, then runs `stage`. The runtime stage is the distroless base plus `/stage/app` and the binaries. |
| `.github/workflows/release-images.yml` | Matrix entries with a `spec` are built, verified, Trivy-scanned and booted before the push build. This happens on every PR and on every release. |

## Staging rules

- **Closure = spec.** `stage` computes the dependency closure of `runtimePackages`, resolved like Bun's hoisted install. It refuses the build when the closure differs from `nodeModules`. A new dependency therefore reaches the image only through a reviewed edit of the spec. An entry may be a glob, for a binding named after the platform. Optional dependencies are staged only when they are installed and match the base's libc: Bun installs both the glibc and the musl bindings.
- **Workspace packages** ship `package.json`, `src/**/*.ts` and `dist/**/*.js`, without tests or `.d.ts` files. npm packages ship whole, without nested installs.
- **`NODE_ENV` stays a run-time read.** By default Bun's bundler replaces `process.env.NODE_ENV` with `"development"` and deletes the branches it then considers dead. In the gateway that removed the `Secure` cookie flag. `stage` defines it as itself, and `scripts/service-image.test.ts` checks the gateway bundle for it.
- **Paths are relative to the module's own directory.** The bundle lives at the same depth as `src/` (`apps/<service>/dist`). Code that resolves a path from `import.meta.dir` (for example the gateway's `packages/plugins`) therefore finds the same place in the image.

## What the bundle hides, the image still says

- **SBOM.** An image scanner finds npm packages by their `package.json`, and a bundle has none. `stage` writes `bundled-packages.cdx.json` (CycloneDX) next to the bundle. It lists every npm package the bundle inlines, plus each binary that has a package URL (Deno as `pkg:cargo/deno@<version>`). CI scans it with `trivy sbom`, and operators can scan it too. Bun has no advisory database entry, so its digest-pinned image tag is its version.
- **Licences.** `third-party-licenses.txt`, next to the bundle, carries the licence text of each inlined package. MIT, BSD, ISC and Zlib all require the notice in copies. A package without a licence file and without a `license` field fails the build.

## CI gates

1. `bun scripts/service-image.ts verify <spec> <image>`: every entry of the layers the image adds to its base must be allowlisted, and none may replace or delete (whiteout) a base file; every required path must exist; every `FROM` of the Dockerfile must be pinned by digest. No shell (`sh`, `bash`, `busybox`, …) may exist anywhere, not even in the base. The image needs a numeric non-root `USER` and an exec-form `ENTRYPOINT`.
2. Trivy (`aquasec/trivy`, pinned by digest, run as an image rather than through trivy-action). It scans the image and the bundle SBOM for high and critical findings with `--ignore-unfixed`: a finding without a fixed version leaves a PR nothing to do.
3. A boot smoke, per service. For the gateway:
   - `image-self-check.js` verifies every shipped plugin against the trust root and runs a probe through the Deno sandbox (`checkPluginRuntime`, plugin-host);
   - the image then boots against a migrated Postgres and answers `/api/_caelo/health?deep=1`;
   - no plugin may fail to load.

## Adding a minimal image (for example the MCP auth proxy)

1. Write `apps/<service>/image.ts`. Start with an empty `nodeModules`. `stage` then fails with one line per package of the closure (`node_modules/<pkg> is in the run-time closure but not in the spec's nodeModules`); review those packages and list them.
2. Write the Dockerfile from the gateway's pattern: digest-pinned `FROM`s, a builder that runs `stage`, a distroless runtime with `USER 65532:65532` and an exec-form `ENTRYPOINT`.
3. Add a matrix entry with `spec` and `sbom` to `release-images.yml`, and a boot smoke step for the service.
4. Add the spec to knip's entry list.

## Reproducible dependency layers (admin, ops; #1559)

Releases stay in the registries for good: Cloud Run jobs pull their image every time they run, so deleting a release would break the jobs of every install still on it (#1558). A layer whose digest changes with every release is therefore uploaded and stored again with every release. The admin and ops images keep their `node_modules` in layers whose digest changes only when the dependencies do.

- **Why the digests changed.** A fresh `bun install` gives every file a new timestamp. A plain `COPY --from=builder /repo/node_modules ./node_modules` also adds an `/app` entry dated at copy time. Between 0.12.3 and 0.12.4, the admin's two dependency layers (254 and 55 MiB compressed) differed only in timestamps: all 101,763 entries had the same path, type, mode, owner and content. In ops' 35 MiB-per-architecture layer, the 28,849 `node_modules` entries were the same too; only its CLI files changed.
- **The rule.**
  - The builder copies each tree under a staging root that holds its whole path: `/deps/root/app/node_modules`, `/deps/admin/app/apps/admin/node_modules`, `/deps/opt/caelo-ops/node_modules`.
  - It gives every entry, parent directories included, one fixed time: `find /deps -exec touch -h -d @946684800 {} +`.
  - The runtime stage copies the root with `COPY --link --from=builder /deps/<root>/ /`. With `--link` the layer is exactly that tree, built independently of the layers before it.
  - Two builds of the same dependencies give byte-identical layers, whether or not the build cache still has them.
  - The admin builder stages before `COPY . .`, so the step runs again only when a manifest or `bun.lock` changes.
  - The time is arbitrary but must stay fixed. 2000-01-01 stays clear of the 1980 floor of ZIP-style timestamps.
- **Why each piece is needed.**
  - Fixing the timestamps alone is not enough: the copy still dates the `/app` entry it adds to.
  - `COPY --link` of `/repo/node_modules` alone is not enough either: it creates `/app` with the build's time.
  - Only a staging root whose top directory is copied as content gives a layer with no dated entry.
  - Local BuildKit experiments (v0.34) showed all three.
- **Why not BuildKit's `rewrite-timestamp`.** A fixed `SOURCE_DATE_EPOCH` would make every layer reproducible, but it would also give the admin's `build/client` one timestamp. adapter-node serves those files through sirv, whose ETag is size plus modification time. A file that changes but keeps its size, such as `_app/version.json`, would then keep its ETag across releases, and browsers would revalidate to the old file.
- **One cache writer per scope.** A GitHub Actions cache scope keeps only its last export. In `release-images.yml` the build that runs before the push build (the ops boot smoke, the minimal images' checks) reads the scope but does not write it. The ops smoke build is amd64 only; its export used to wipe the push build's arm64 half. Every ops build then rebuilt its arm64 runtime chain (Node, the Pulumi/gcloud layer, the CLI), and every release carried about 369 MB of new arm64 layers. The push build reuses the earlier build's layers from the job's own builder anyway.
- **What still changes with every release.**
  - The admin: its `packages` and `apps/admin/build`, the version-stamped `package.json` and `bun.lock`, and SvelteKit's generated route types in `apps/admin/node_modules/$app`, in a small layer of their own.
  - ops: its CLI and packages.
  - The gateway and the MCP-Auth-Proxy are bundles that inline their dependencies, so their app layer is their code.
  - The SBOM and provenance attestations buildx attaches to every image are new with every build: about 53 MB for ops (both architectures; gcloud's SDK makes its SBOM large), 5 MB for the admin, 2 MB for the gateway and proxy.
- **Keeping it.**
  - `scripts/reproducible-image-layers.test.ts` fails when a runtime stage copies a dependency tree any other way, or when the admin stages it after the source.
  - To check the registry, compare the layers of two builds (the platform manifest plus its config `history`). The dependency layers of two builds without a `bun.lock` change must have equal digests.
