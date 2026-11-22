// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 — a plugin's collection store comes from the install's env,
 * with no fallback: unset on a Google Cloud or self-hosted install it names
 * the variable and the step that sets it; on AWS and Azure, which have no
 * store yet, it names the gap and its issue, so the Stage records the
 * plugin's collections as failed with that reason.
 */

import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectionStoreFromEnv, STAGING_COLLECTION_STORE_ENV } from "./collections-host.js";

describe("collectionStoreFromEnv", () => {
  it("names the AWS and Azure gap with its issue", () => {
    expect(() =>
      collectionStoreFromEnv(STAGING_COLLECTION_STORE_ENV, { CAELO_PROVIDER: "aws" }),
    ).toThrow(/no store on provider "aws" yet \(issue #749/);
    expect(() =>
      collectionStoreFromEnv(STAGING_COLLECTION_STORE_ENV, { CAELO_PROVIDER: "azure" }),
    ).toThrow(/no store on provider "azure" yet \(issue #750/);
  });

  it("names the variable and the step that sets it everywhere else", () => {
    for (const provider of ["gcp", "gcp-firebase", "self-hosted", undefined]) {
      expect(() =>
        collectionStoreFromEnv(STAGING_COLLECTION_STORE_ENV, { CAELO_PROVIDER: provider }),
      ).toThrow(/CAELO_COLLECTIONS_STAGING_STORE is not set.*cms-provision upgrade/);
    }
  });

  it("opens the store a set variable names", () => {
    const store = collectionStoreFromEnv(STAGING_COLLECTION_STORE_ENV, {
      // Opening touches nothing on disk; the directory need not exist.
      CAELO_COLLECTIONS_STAGING_STORE: `file://${join(tmpdir(), "caelo-store-env-test")}`,
    });
    expect(typeof store.read).toBe("function");
  });
});
