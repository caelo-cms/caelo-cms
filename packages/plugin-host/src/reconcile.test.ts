// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { externalIdentityChanged } from "./reconcile.js";

const approval = (artifactDigest: string, grantIds: string[]) => ({
  externalApproval: { artifactDigest, grantIds, capabilities: [], systemActorId: "x" },
});

describe("externalIdentityChanged", () => {
  it("is false for a release-signed plugin (no external approval)", () => {
    expect(externalIdentityChanged({}, { artifact_digest: null, grant_ids: "" })).toBe(false);
  });

  it("is false while the approved artifact and its grants are unchanged", () => {
    expect(
      externalIdentityChanged(approval("a".repeat(64), ["7", "12"]), {
        artifact_digest: "a".repeat(64),
        grant_ids: "12,7",
      }),
    ).toBe(false);
  });

  it("is true when a new artifact was approved under the same version", () => {
    expect(
      externalIdentityChanged(approval("a".repeat(64), []), {
        artifact_digest: "b".repeat(64),
        grant_ids: "",
      }),
    ).toBe(true);
  });

  it("is true when the grants were re-issued", () => {
    expect(
      externalIdentityChanged(approval("a".repeat(64), ["7"]), {
        artifact_digest: "a".repeat(64),
        grant_ids: "9",
      }),
    ).toBe(true);
  });
});
