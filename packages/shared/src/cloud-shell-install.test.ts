// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  CLOUD_SHELL_UPGRADE_FIRST_VERSION,
  cloudShellInstallUrl,
  cloudShellUpgradeCommand,
  cloudShellUpgradeUrl,
} from "./cloud-shell-install.js";

describe("cloudShellInstallUrl", () => {
  it("names no version: the install repo's main installs the newest release", () => {
    expect(cloudShellInstallUrl("gcp")).toBe(
      "https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/caelo-cms/install&cloudshell_git_branch=main&cloudshell_tutorial=gcp.md",
    );
    expect(cloudShellInstallUrl("gcp-firebase")).toContain(
      "cloudshell_git_branch=main&cloudshell_tutorial=gcp-firebase.md",
    );
  });
});

describe("cloudShellUpgradeUrl (#816)", () => {
  it("opens the release's upgrade walkthrough, never the install one", () => {
    const url = cloudShellUpgradeUrl(CLOUD_SHELL_UPGRADE_FIRST_VERSION, "gcp-firebase");
    expect(url).toBe(
      `https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/caelo-cms/install&cloudshell_git_branch=release-v${CLOUD_SHELL_UPGRADE_FIRST_VERSION}&cloudshell_tutorial=upgrade-gcp-firebase.md`,
    );
    expect(cloudShellUpgradeUrl("v9.0.0", "gcp")).toContain(
      "cloudshell_git_branch=release-v9.0.0&cloudshell_tutorial=upgrade-gcp.md",
    );
    expect(url).not.toContain("tutorial=gcp-firebase.md");
  });

  it("no link for a release whose branch has no upgrade tutorial, or a pre-release", () => {
    expect(cloudShellUpgradeUrl("0.10.59", "gcp")).toBeNull();
    expect(cloudShellUpgradeUrl("0.11.0-rc.1", "gcp")).toBeNull();
    expect(cloudShellUpgradeUrl("latest", "gcp")).toBeNull();
  });
});

describe("cloudShellUpgradeCommand", () => {
  it("names the install, and its project when known", () => {
    expect(cloudShellUpgradeCommand({ project: "acme-site", install: "acme.com" })).toBe(
      "./run.sh upgrade --project acme-site --install acme.com",
    );
    expect(cloudShellUpgradeCommand({ project: null, install: "acme.com" })).toBe(
      "./run.sh upgrade --install acme.com",
    );
  });
});
