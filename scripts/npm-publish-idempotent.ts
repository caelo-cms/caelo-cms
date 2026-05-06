#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * Idempotent `npm publish` wrapper for the release workflow.
 *
 * Why this exists: npm 11.x with `--provenance` + Trusted Publishing has a
 * race where the package PUT to the registry succeeds, but the CLI then
 * does a follow-up call (after the Sigstore/Rekor provenance attestation
 * lands) and gets a 403 "You cannot publish over the previously published
 * versions: X.Y.Z" — even though the artifact (with provenance) is already
 * live on npm. The publish step exits non-zero and the rest of the release
 * pipeline (verify-published, github-release) skips.
 *
 * Observed on v0.2.3 / provisioning: package landed at 10:59:57.507Z with
 * a valid attestation; second PUT at 10:59:58.450 hit 403; step failed.
 *
 * Detection: capture whether the version exists on the registry BEFORE we
 * run npm publish. If it doesn't exist before but does exist after a 403
 * "already published" failure, THIS run published it and the failure is
 * the npm CLI race — exit 0. If it existed before AND we get a 403,
 * something else (a prior CI run, a manual publish) shipped this version
 * — propagate the failure so the operator bumps + re-tags.
 *
 * Why not compare tarball shasums: `npm pack --dry-run` produces a
 * different shasum than the real publish's internal pack (timestamps
 * drift between the two pack invocations even on the same source tree),
 * so a shasum check would false-positive into "different shasum, fail".
 * Existence-before-vs-after is the cleaner signal.
 *
 * Usage (called from .github/workflows/release.yml inside the package's
 * working directory):
 *   bun /repo/scripts/npm-publish-idempotent.ts --tag <dist-tag>
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tagFlagIndex = process.argv.indexOf("--tag");
const distTag =
  tagFlagIndex >= 0 ? process.argv[tagFlagIndex + 1] : "latest";

if (!distTag) {
  console.error("npm-publish-idempotent: missing --tag <dist-tag>");
  process.exit(2);
}

const pkgJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  name: string;
  version: string;
};
const { name, version } = pkgJson;

console.log(
  `npm-publish-idempotent: publishing ${name}@${version} with --tag ${distTag}`,
);

/**
 * Returns true iff the registry has a record for ${name}@${version}.
 * Doesn't care about shasum — just existence.
 */
function versionExistsOnRegistry(): boolean {
  const result = spawnSync(
    "npm",
    ["view", `${name}@${version}`, "version", "--json"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    // `npm view` exits non-zero for "no such version" — that's our
    // "doesn't exist" signal. Other errors (network, auth) also
    // exit non-zero, but we surface them via stderr for the operator
    // to see in the CI log.
    if (result.stderr) {
      console.log(
        `npm-publish-idempotent: \`npm view\` returned non-zero — assuming version not yet published. (stderr: ${result.stderr.trim().slice(0, 200)})`,
      );
    }
    return false;
  }
  // npm view <pkg>@<ver> version --json prints "X.Y.Z" (a JSON string)
  // when the version exists. An empty string or empty array means not
  // there.
  const trimmed = result.stdout.trim();
  if (!trimmed || trimmed === "" || trimmed === "[]" || trimmed === "{}") {
    return false;
  }
  return true;
}

const existedBefore = versionExistsOnRegistry();
console.log(
  `npm-publish-idempotent: version exists on registry BEFORE publish: ${existedBefore}`,
);

// Run the real publish. Inherit stdio so users see live npm output in
// the CI log as before; we don't need to capture it to detect the
// failure mode — exit status + a follow-up `npm view` is enough.
const publishResult = spawnSync(
  "npm",
  ["publish", "--provenance", "--access", "public", "--tag", distTag],
  { stdio: "inherit" },
);

if (publishResult.status === 0) {
  console.log("npm-publish-idempotent: publish succeeded normally");
  process.exit(0);
}

console.log(
  `\nnpm-publish-idempotent: npm publish exited ${publishResult.status} — checking whether THIS run published the artifact anyway...`,
);

const existsAfter = versionExistsOnRegistry();
console.log(
  `npm-publish-idempotent: version exists on registry AFTER publish: ${existsAfter}`,
);

if (existsAfter && !existedBefore) {
  console.log(
    `npm-publish-idempotent: ${name}@${version} was NOT on the registry before this run, IS on the registry now — THIS run published it. Treating the npm CLI exit code as a known --provenance race; exiting 0.`,
  );
  console.log(
    "  (See scripts/npm-publish-idempotent.ts header — npm 11.x's Trusted Publishing flow can do a duplicate PUT after the Rekor attestation lands; the package + attestation are live.)",
  );
  process.exit(0);
}

if (existsAfter && existedBefore) {
  console.error(
    `npm-publish-idempotent: ${name}@${version} was ALREADY on the registry before this run started.`,
  );
  console.error(
    "  Some earlier process (a prior CI run, a manual publish) shipped this version. Bump the version and re-tag.",
  );
  process.exit(publishResult.status ?? 1);
}

console.error(
  `npm-publish-idempotent: ${name}@${version} is NOT on the registry — propagating the original publish failure.`,
);
process.exit(publishResult.status ?? 1);
