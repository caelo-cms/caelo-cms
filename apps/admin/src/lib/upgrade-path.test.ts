// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  CLOUD_SHELL_UPGRADE_FIRST_VERSION,
  cloudShellInstallUrl,
  cloudShellUpgradeUrl,
} from "@caelo-cms/shared";
import { cloudShellUpgrade, resolveUpgradePath, type UpgradePath } from "./upgrade-path.js";

const gcp = {
  CAELO_PROVIDER: "gcp",
  CAELO_SITE_URL: "https://example.com",
  NODE_ENV: "production",
};

describe("resolveUpgradePath", () => {
  it("builds the pinned command for a Google Cloud install, named by its domain", () => {
    const p = resolveUpgradePath(gcp, "0.10.44");
    expect(p).toEqual({
      kind: "cli",
      provider: "gcp",
      install: "example.com",
      command:
        "bunx @caelo-cms/provisioning@0.10.44 upgrade --version 0.10.44 --install example.com",
      docsUrl: "https://caelo-cms.com/docs/install/maintenance/",
    });
  });

  it("covers gcp-firebase like gcp", () => {
    const p = resolveUpgradePath({ ...gcp, CAELO_PROVIDER: "gcp-firebase" }, "0.10.44");
    expect(p.kind).toBe("cli");
  });

  it("offers no command where `upgrade` is not implemented", () => {
    expect(resolveUpgradePath({ ...gcp, CAELO_PROVIDER: "aws" }, "0.10.44")).toEqual({
      kind: "unsupported",
      providerLabel: "AWS",
      docsUrl: "https://caelo-cms.com/docs/install/",
    });
  });

  it("builds the server-side command for a self-hosted install (#696 Phase 4)", () => {
    const selfHosted: UpgradePath = {
      kind: "cli",
      provider: "self-hosted",
      install: "example.com",
      // No --install: the CLI finds the install by the folder it runs in.
      command: "bunx @caelo-cms/provisioning@0.10.44 upgrade --version 0.10.44",
      docsUrl: "https://caelo-cms.com/docs/install/maintenance/",
    };
    expect(
      resolveUpgradePath(
        { CAELO_PROVIDER: "self-hosted", CAELO_SITE_URL: "https://example.com" },
        "0.10.44",
      ),
    ).toEqual(selfHosted);
    // Older Compose files set no CAELO_PROVIDER: still self-hosted.
    expect(resolveUpgradePath({ CAELO_SITE_URL: "https://example.com" }, "0.10.44")).toEqual(
      selfHosted,
    );
  });

  it("says what is missing instead of guessing the install", () => {
    const missing = resolveUpgradePath({ CAELO_PROVIDER: "gcp" }, "0.10.44");
    expect(missing.kind).toBe("misconfigured");
    const bad = resolveUpgradePath({ ...gcp, CAELO_SITE_URL: "not a url" }, "0.10.44");
    expect(bad.kind).toBe("misconfigured");
  });

  it("honours the e2e provider stand-in outside production only", () => {
    const env = { CAELO_SITE_URL: "https://example.com", CAELO_E2E_UPDATES_PROVIDER: "gcp" };
    expect(resolveUpgradePath({ ...env, NODE_ENV: "development" }, "0.10.44").kind).toBe("cli");
    expect(resolveUpgradePath({ ...env, NODE_ENV: "production" }, "0.10.44")).toMatchObject({
      kind: "cli",
      provider: "self-hosted",
    });
  });
});

describe("cloudShellUpgrade (#816)", () => {
  const withJob = {
    ...gcp,
    CAELO_UPGRADER_JOB: "projects/acme-prod/locations/europe-west1/jobs/caelo-production-upgrader",
  };

  it("one button to the release's upgrade walkthrough and one ./run.sh upgrade line", () => {
    const c = cloudShellUpgrade(withJob, CLOUD_SHELL_UPGRADE_FIRST_VERSION);
    expect(c).toEqual({
      consoleUrl: cloudShellUpgradeUrl(CLOUD_SHELL_UPGRADE_FIRST_VERSION, "gcp"),
      projectId: "acme-prod",
      command: "./run.sh upgrade --project acme-prod --install example.com",
    });
  });

  it("never links the install walkthrough and never pastes an unverified installer", () => {
    const c = cloudShellUpgrade(withJob, CLOUD_SHELL_UPGRADE_FIRST_VERSION);
    expect(c?.consoleUrl).toContain("cloudshell_tutorial=upgrade-gcp.md");
    expect(c?.consoleUrl).not.toBe(cloudShellInstallUrl(CLOUD_SHELL_UPGRADE_FIRST_VERSION, "gcp"));
    expect(c?.command).not.toContain("curl");
    expect(c?.command).not.toContain("bun.sh");
    expect(c?.command).not.toContain("skip-verify");
  });

  it("without the job's project: the walkthrough finds the install by itself", () => {
    const c = cloudShellUpgrade(gcp, CLOUD_SHELL_UPGRADE_FIRST_VERSION);
    expect(c?.projectId).toBeNull();
    expect(c?.command).toBe("./run.sh upgrade --install example.com");
  });

  it("a release without the walkthrough (pre-release, older branch): no button, the CLI command", () => {
    for (const version of ["0.11.0-rc.1", "0.10.59"]) {
      const c = cloudShellUpgrade(withJob, version);
      expect(c?.consoleUrl).toBeNull();
      expect(c?.command).toBe(
        `bunx @caelo-cms/provisioning@${version} upgrade --version ${version} --install example.com`,
      );
    }
  });

  it("is null where the CLI cannot upgrade", () => {
    expect(cloudShellUpgrade({ CAELO_SITE_URL: "https://example.com" }, "0.11.0")).toBeNull();
  });
});
