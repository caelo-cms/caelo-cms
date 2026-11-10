// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { chooseImageDigests } from "./deployed-release.js";
import {
  decideInstallVersion,
  installRecordFromManifest,
  launcherRecordsRelease,
} from "./install-version.js";

const d = (c: string) => `sha256:${c.repeat(64)}`;

describe("decideInstallVersion (#1558)", () => {
  it("leaves the wizard's usual choice alone without --version", () => {
    expect(
      decideInstallVersion({ requested: undefined, deployed: false, recordedVersion: undefined }),
    ).toEqual({ kind: "none" });
  });

  it("installs the named release on an install that is not provisioned yet", () => {
    expect(
      decideInstallVersion({
        requested: "v0.12.5-rc.1",
        deployed: false,
        recordedVersion: "0.12.4",
      }),
    ).toEqual({ kind: "install", version: "0.12.5-rc.1" });
    expect(
      decideInstallVersion({ requested: "0.12.4", deployed: false, recordedVersion: undefined }),
    ).toEqual({ kind: "install", version: "0.12.4" });
  });

  it("keeps the release a provisioned install runs when it is the one named", () => {
    expect(
      decideInstallVersion({
        requested: "0.12.5-rc.1",
        deployed: true,
        recordedVersion: "0.12.5-rc.1",
      }),
    ).toEqual({ kind: "keep", version: "0.12.5-rc.1" });
  });

  it("never changes the release of a provisioned install: that is upgrade's job", () => {
    const r = decideInstallVersion({
      requested: "0.12.5",
      deployed: true,
      recordedVersion: "0.12.4",
    });
    expect(r.kind).toBe("refuse");
    const error = r.kind === "refuse" ? r.error : "";
    expect(error).toContain("already runs v0.12.4");
    expect(error).toContain("bunx @caelo-cms/provisioning@0.12.5 upgrade --version 0.12.5");
    const unknown = decideInstallVersion({
      requested: "0.12.5",
      deployed: true,
      recordedVersion: undefined,
    });
    expect(unknown.kind === "refuse" && unknown.error).toContain("already runs a release");
  });

  it("refuses anything that is not a release version", () => {
    for (const requested of ["latest", "rc", "0.12", "0.12.4; rm -rf /", ""]) {
      const r = decideInstallVersion({ requested, deployed: false, recordedVersion: undefined });
      expect(r.kind).toBe("refuse");
    }
  });
});

describe("installRecordFromManifest", () => {
  const digests = {
    admin: d("a"),
    gateway: d("b"),
    ops: d("c"),
    "mcp-auth-proxy": d("e"),
  };

  it("records the three images the stack deploys and the version", () => {
    expect(installRecordFromManifest({ version: "0.12.5-rc.1", digests })).toEqual({
      ok: true,
      digests: { admin: d("a"), gateway: d("b"), "mcp-auth-proxy": d("e") },
      version: "0.12.5-rc.1",
    });
  });

  it("refuses a release from before the MCP-Auth-Proxy", () => {
    const { "mcp-auth-proxy": _, ...old } = digests;
    const r = installRecordFromManifest({ version: "0.11.9", digests: old });
    expect(r.ok).toBe(false);
  });

  // Regression: the job-mode launcher recorded only admin + gateway, and the
  // job's release choice refuses a record without the MCP-Auth-Proxy since
  // #1328, so every Cloud Shell fresh install stopped at "Choosing the
  // release images".
  it("writes a record the install job's release choice accepts", async () => {
    const record = installRecordFromManifest({ version: "0.12.4", digests });
    if (!record.ok) throw new Error(record.error);
    const unused = async (): Promise<never> => {
      throw new Error("not reached");
    };
    const choice = await chooseImageDigests({
      recorded: record.digests,
      deployed: false,
      readLive: unused,
      resolveLatest: unused,
    });
    expect(choice).toEqual({ ok: true, source: "recorded", digests: record.digests });
    const before = await chooseImageDigests({
      recorded: { admin: d("a"), gateway: d("b") },
      deployed: false,
      readLive: unused,
      resolveLatest: unused,
    });
    expect(before.ok).toBe(false);
  });
});

describe("launcherRecordsRelease", () => {
  const full = { admin: d("a"), gateway: d("b"), "mcp-auth-proxy": d("e") };

  it("never records once the first pulumi up succeeded", () => {
    for (const requested of [true, false]) {
      expect(launcherRecordsRelease({ deployed: true, requested, recorded: null })).toBe(false);
    }
  });

  it("records a named version, a first run, and over a record without the proxy", () => {
    expect(launcherRecordsRelease({ deployed: false, requested: true, recorded: full })).toBe(true);
    expect(launcherRecordsRelease({ deployed: false, requested: false, recorded: null })).toBe(
      true,
    );
    expect(
      launcherRecordsRelease({
        deployed: false,
        requested: false,
        recorded: { admin: d("a"), gateway: d("b") },
      }),
    ).toBe(true);
  });

  it("keeps a complete record when no version was named", () => {
    expect(launcherRecordsRelease({ deployed: false, requested: false, recorded: full })).toBe(
      false,
    );
  });
});
