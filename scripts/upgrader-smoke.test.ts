// SPDX-License-Identifier: MPL-2.0

/**
 * #818 — the upgrader smoke test's own logic: which update it tests (the
 * release train, N-1 first), when it refuses, and what counts as "the
 * candidate serves". The cloud half runs only in upgrader-smoke.yml.
 */

import { describe, expect, it } from "bun:test";
import type { InstallMetadata } from "../packages/provisioning/src/install-state.ts";
import type { ReleaseManifest } from "../packages/provisioning/src/release-manifest.ts";
import { releaseImageRef } from "../packages/provisioning/src/upgrade/release-images.ts";
import {
  planSmoke,
  previousStable,
  type SmokeObservation,
  serviceReady,
  smokeFailures,
} from "./upgrader-smoke.ts";

const D = (c: string) => `sha256:${c.repeat(64)}`;

describe("previousStable", () => {
  const tags = [
    "v0.10.51",
    "v0.10.52",
    "v0.10.53",
    "v0.11.0-rc.1",
    "v0.11.0-rc.2",
    "v0.9.9",
    "junk",
  ];

  it("is the newest stable tag below the candidate, skipping pre-releases", () => {
    expect(previousStable(tags, "0.11.0-rc.2")).toBe("0.10.53");
    expect(previousStable(tags, "0.11.0")).toBe("0.10.53");
    expect(previousStable(tags, "0.10.53")).toBe("0.10.52");
    expect(previousStable(tags, "0.10.53-rc.1")).toBe("0.10.52");
  });

  it("is null when nothing stable came before", () => {
    expect(previousStable(tags, "0.9.9")).toBeNull();
  });
});

describe("planSmoke", () => {
  it("tests N-1 → candidate when the install is at N-1", () => {
    expect(
      planSmoke({ installed: "0.10.53", previous: "0.10.53", candidate: "0.11.0-rc.1" }),
    ).toEqual({
      kind: "install",
      versions: ["0.11.0-rc.1"],
      note: "Testing 0.10.53 → 0.11.0-rc.1.",
    });
  });

  it("brings an install behind N-1 to N-1 first", () => {
    const p = planSmoke({ installed: "0.10.50", previous: "0.10.53", candidate: "0.11.0-rc.1" });
    expect(p.kind === "install" && p.versions).toEqual(["0.10.53", "0.11.0-rc.1"]);
  });

  it("rides the release train from an earlier candidate of the same cycle", () => {
    const p = planSmoke({
      installed: "0.11.0-rc.1",
      previous: "0.10.53",
      candidate: "0.11.0-rc.2",
    });
    expect(p.kind === "install" && p.versions).toEqual(["0.11.0-rc.2"]);
    expect(p.kind === "install" && p.note).toContain("release train");
  });

  it("only re-checks a candidate that is already installed (an idempotent re-run)", () => {
    expect(
      planSmoke({ installed: "0.11.0-rc.1", previous: "0.10.53", candidate: "0.11.0-rc.1" }).kind,
    ).toBe("verify-only");
  });

  it("refuses an install that is ahead of the candidate, naming the reset", () => {
    const p = planSmoke({ installed: "0.11.0", previous: "0.10.53", candidate: "0.11.0-rc.2" });
    expect(p.kind).toBe("refuse");
    expect(p.kind === "refuse" && p.reason).toContain("Reset");
  });
});

const MANIFEST: ReleaseManifest = {
  manifestVersion: 1,
  version: "0.11.0-rc.1",
  channel: "rc",
  digests: { admin: D("a"), gateway: D("b"), ops: D("c") },
  minFromVersion: "0.10.0",
  infraContractVersion: 5,
  migrations: { contract: false, lastContractVersion: null, head: "0289_x" },
  security: false,
  advisories: [],
};

const INSTALL = {
  installId: "gcp-firebase-smoke",
  provider: "gcp-firebase",
  projectId: "smoke",
  domain: "smoke.example.com",
  ownerEmail: "owner@example.com",
  region: "europe-west1",
  createdAt: "2026-10-01T00:00:00Z",
  releaseVersion: "0.11.0-rc.1",
  imageDigests: { admin: D("a"), gateway: D("b") },
} as InstallMetadata;

const SERVING: SmokeObservation = {
  install: INSTALL,
  // Cloud Run also reports the platform manifest inside the index (#860).
  serving: { admin: [D("a"), D("e")], gateway: [D("b"), D("f")] },
  ready: { admin: true, gateway: true },
  upgraderImage: releaseImageRef("ops", D("c")),
};

describe("smokeFailures", () => {
  it("passes when records, serving revisions, readiness and the upgrader all name the candidate", () => {
    expect(smokeFailures(MANIFEST, SERVING)).toEqual([]);
  });

  it("names every way the candidate does not serve", () => {
    const failures = smokeFailures(MANIFEST, {
      install: {
        ...INSTALL,
        releaseVersion: "0.10.53",
        imageDigests: { admin: D("1"), gateway: D("b") },
      },
      serving: { admin: [D("1")], gateway: [] },
      ready: { admin: true, gateway: false },
      upgraderImage: releaseImageRef("ops", D("9")),
    });
    expect(failures).toHaveLength(6);
    expect(failures.join("\n")).toContain("records 0.10.53");
    expect(failures.join("\n")).toContain("gateway service is not Ready");
    expect(failures.join("\n")).toContain("upgrader job runs");
  });

  it("a missing install.json is a failure, not a pass", () => {
    expect(smokeFailures(MANIFEST, { ...SERVING, install: null })).toContain(
      "install.json is missing from the ops bucket",
    );
  });
});

describe("serviceReady", () => {
  it("reads Cloud Run's Ready condition", () => {
    const json = (status: string) =>
      JSON.stringify({ status: { conditions: [{ type: "Ready", status }] } });
    expect(serviceReady(json("True"))).toBe(true);
    expect(serviceReady(json("False"))).toBe(false);
    expect(serviceReady("{}")).toBe(false);
    expect(serviceReady("not json")).toBe(false);
  });
});
