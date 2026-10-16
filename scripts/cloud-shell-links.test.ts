// SPDX-License-Identifier: MPL-2.0

/**
 * The Cloud Shell install links (#696) in the README: release.ts moves
 * them on every stable release, and each one is exactly what
 * `cloudShellInstallUrl` builds for the current version.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CAELO_VERSION, cloudShellInstallUrl } from "@caelo-cms/shared";
import {
  CLOUD_SHELL_BRANCH,
  CLOUD_SHELL_LINK_FILES,
  pinCloudShellLinks,
} from "./cloud-shell-links.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const LINK = /https:\/\/shell\.cloud\.google\.com\/cloudshell\/editor\?[^)\s"'<>]+/g;

describe("pinCloudShellLinks", () => {
  const text = `[a](${cloudShellInstallUrl("0.10.46", "gcp")}) and [b](${cloudShellInstallUrl("0.10.46", "gcp-firebase")})`;

  it("moves every link to a new stable release", () => {
    const next = pinCloudShellLinks(text, "0.10.47");
    expect(next).toBe(
      `[a](${cloudShellInstallUrl("0.10.47", "gcp")}) and [b](${cloudShellInstallUrl("0.10.47", "gcp-firebase")})`,
    );
  });

  it("leaves the links on the last stable release for a pre-release", () => {
    expect(pinCloudShellLinks(text, "0.11.0-rc.1")).toBe(text);
  });
});

describe("the Cloud Shell links in the README", () => {
  for (const file of CLOUD_SHELL_LINK_FILES) {
    const text = readFileSync(resolve(REPO_ROOT, file), "utf8");
    const links = text.match(LINK) ?? [];

    it(`${file} has a Cloud Shell install link`, () => {
      expect(links.length).toBeGreaterThan(0);
    });

    it(`${file}: every link is cloudShellInstallUrl() for the current stable version`, () => {
      const stable = /^\d+\.\d+\.\d+$/.test(CAELO_VERSION);
      for (const link of links) {
        const provider = /cloudshell_tutorial=(gcp-firebase|gcp)\.md/.exec(link)?.[1];
        expect(provider).toBeDefined();
        const pinned = [...link.matchAll(CLOUD_SHELL_BRANCH)][0]?.[1] ?? "";
        // Between a pre-release and the next stable one the links keep the
        // last stable version; otherwise they name exactly this release.
        const version = stable ? CAELO_VERSION : pinned;
        expect(link).toBe(cloudShellInstallUrl(version, provider as "gcp" | "gcp-firebase"));
      }
    });
  }
});
