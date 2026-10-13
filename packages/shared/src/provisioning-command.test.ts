// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  installHintFromSiteUrl,
  provisioningCommand,
  provisioningUpgradeCommand,
} from "./provisioning-command.js";
import { isNewerVersion } from "./version.js";

describe("provisioningCommand", () => {
  it("pins the package to an exact version", () => {
    expect(provisioningCommand("0.10.44", ["status"])).toBe(
      "bunx @caelo-cms/provisioning@0.10.44 status",
    );
    expect(provisioningCommand("v0.10.44")).toBe("bunx @caelo-cms/provisioning@0.10.44");
  });

  it("refuses a tag or anything else that is not a version", () => {
    expect(() => provisioningCommand("latest")).toThrow(/invalid Caelo version/);
    expect(() => provisioningCommand("0.10")).toThrow(/invalid Caelo version/);
  });
});

describe("provisioningUpgradeCommand", () => {
  it("runs the target release's CLI, rolls exactly that release, on exactly this install", () => {
    expect(provisioningUpgradeCommand({ version: "0.10.44", install: "example.com" })).toBe(
      "bunx @caelo-cms/provisioning@0.10.44 upgrade --version 0.10.44 --install example.com",
    );
  });

  it("accepts a v-prefixed tag and a pre-release", () => {
    expect(provisioningUpgradeCommand({ version: "v0.11.0-rc.1", install: "gcp-acme" })).toBe(
      "bunx @caelo-cms/provisioning@0.11.0-rc.1 upgrade --version 0.11.0-rc.1 --install gcp-acme",
    );
  });

  it("refuses an install hint the shell could interpret", () => {
    for (const install of ["example.com; rm -rf ~", "$(id)", "a b", "", "Example.com"]) {
      expect(() => provisioningUpgradeCommand({ version: "0.10.44", install })).toThrow(
        /not a domain/,
      );
    }
  });
});

describe("installHintFromSiteUrl", () => {
  it("names the install by its site's domain", () => {
    expect(installHintFromSiteUrl("https://Example.com")).toBe("example.com");
    expect(installHintFromSiteUrl("https://www.example.co.uk/")).toBe("www.example.co.uk");
  });

  it("returns null for something that is not a URL", () => {
    expect(installHintFromSiteUrl("example.com")).toBeNull();
    expect(installHintFromSiteUrl("")).toBeNull();
  });
});

describe("isNewerVersion", () => {
  it("orders by major, minor, patch", () => {
    expect(isNewerVersion("0.10.44", "0.10.43")).toBe(true);
    expect(isNewerVersion("0.11.0", "0.10.99")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("0.10.43", "0.10.43")).toBe(false);
    expect(isNewerVersion("0.10.42", "0.10.43")).toBe(false);
  });

  it("sorts a pre-release before its stable", () => {
    expect(isNewerVersion("0.11.0-rc.1", "0.11.0")).toBe(false);
    expect(isNewerVersion("0.11.0", "0.11.0-rc.1")).toBe(true);
    expect(isNewerVersion("0.11.0-rc.2", "0.11.0-rc.1")).toBe(true);
  });

  it("ignores a leading v and treats a non-version as never newer", () => {
    expect(isNewerVersion("v0.10.44", "0.10.43")).toBe(true);
    expect(isNewerVersion("nightly", "0.10.43")).toBe(false);
  });
});
