// SPDX-License-Identifier: MPL-2.0
/**
 * Install entry points name no version: the README's "Open in Cloud Shell"
 * buttons open the install repository's main, whose run.sh installs the
 * newest stable release. A link pinned to one release goes stale with the
 * next one (and was broken for up to 30 minutes after each release, until
 * the install repository created the branch it named).
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cloudShellInstallUrl } from "../packages/shared/src/cloud-shell-install.ts";

const README = readFileSync(resolve(import.meta.dir, "../README.md"), "utf8");
const links = [
  ...README.matchAll(/https:\/\/shell\.cloud\.google\.com\/cloudshell\/editor\?[^)\s]+/g),
].map((m) => m[0]);

describe("README install links", () => {
  it("are the versionless install links, one per provider", () => {
    expect(links.sort()).toEqual(
      [cloudShellInstallUrl("gcp"), cloudShellInstallUrl("gcp-firebase")].sort(),
    );
  });

  it("name no release", () => {
    expect(README).not.toMatch(/cloudshell_git_branch=release-v/);
    expect(README).not.toMatch(/@caelo-cms\/provisioning@\d/);
  });
});
