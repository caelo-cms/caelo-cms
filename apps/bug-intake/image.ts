// SPDX-License-Identifier: MPL-2.0

/**
 * What the bug intake image contains, in the shape of the gateway's
 * (docs/dev/service-images.md). Read by `scripts/service-image.ts`: `stage`
 * builds the app tree from it inside apps/bug-intake/Dockerfile, `verify`
 * checks the built image against it in CI (bug-intake-image.yml).
 *
 * The intake takes signed reports from every install on the internet, so it
 * gets the minimal image of a public service. It is also one bundled file
 * for its start: Cloud Run starts an instance for nearly every request the
 * installs send, and loading the source tree (several thousand files under
 * node_modules) took about 25 s at the full hour, when Cloud Run starts many
 * instances at once, past the 10 s an install waits for its answer.
 */

import type { ServiceImageSpec } from "../../scripts/service-image.ts";

const spec: ServiceImageSpec = {
  dockerfile: "apps/bug-intake/Dockerfile",
  appRoot: "/app",
  bundle: {
    entrypoints: ["apps/bug-intake/src/main.ts"],
    outdir: "apps/bug-intake/dist",
    external: [],
  },
  runtimePackages: [],
  // gcr.io/distroless/cc-debian13 (the Dockerfile's runtime base, the gateway's).
  libc: "glibc",
  nodeModules: [],
  copy: [],
  binaries: [
    // No advisory database tracks Bun releases; the builder's digest-pinned
    // oven/bun tag is its version, bumped by Dependabot.
    { path: "usr/local/bin/bun", purl: null },
  ],
  extraFiles: [],
  require: ["usr/local/bin/bun", "app/apps/bug-intake/dist/main.js"],
};

export default spec;
