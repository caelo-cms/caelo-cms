// SPDX-License-Identifier: MPL-2.0

/**
 * #1271 — every media variant row carries the published digests of its
 * stored file (`media.upload` requires them). Tests that seed a row whose
 * file is never published use {@link TEST_MEDIA_DIGEST}; a test that builds
 * pages from it passes the digest of the bytes it stores (`digestBytes`),
 * so the published names match the file.
 */

import type { PublishedDigest } from "@caelo-cms/static-generator";

/** A well-formed digest for rows whose file no build reads or publishes. */
export const TEST_MEDIA_DIGEST: PublishedDigest = {
  contentSha256: "0".repeat(64),
  size: 4,
  gzipSha256: "1".repeat(64),
  gzipSize: 24,
  profile: "test-profile",
};
