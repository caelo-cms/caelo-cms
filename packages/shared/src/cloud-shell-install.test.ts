// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { cloudShellInstallUrl } from "./cloud-shell-install.js";

describe("cloudShellInstallUrl", () => {
  it("pins the release branch of the install repo and the provider's tutorial", () => {
    expect(cloudShellInstallUrl("0.10.47", "gcp")).toBe(
      "https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/caelo-cms/install&cloudshell_git_branch=release-v0.10.47&cloudshell_tutorial=gcp.md",
    );
    expect(cloudShellInstallUrl("v1.2.3", "gcp-firebase")).toContain(
      "cloudshell_git_branch=release-v1.2.3&cloudshell_tutorial=gcp-firebase.md",
    );
  });

  it("refuses pre-releases and garbage: they have no pinned branch", () => {
    expect(() => cloudShellInstallUrl("0.11.0-rc.1", "gcp")).toThrow(/only stable releases/);
    expect(() => cloudShellInstallUrl("latest", "gcp")).toThrow();
  });
});
