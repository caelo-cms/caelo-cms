// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { initDelegatesToWizard, resolveCliRoute } from "./cli-routing.js";

const HANDLERS = ["init", "upgrade", "wizard", "version", "--version", "-v"];
const argv = (...rest: string[]) => ["bun", "cli.js", ...rest];

describe("resolveCliRoute", () => {
  it("routes the documented flags-only invocation to the wizard", () => {
    expect(
      resolveCliRoute(argv("--provider", "gcp-firebase", "--domain", "example.com"), HANDLERS),
    ).toEqual({ kind: "wizard" });
  });

  it("routes a bare invocation to the wizard", () => {
    expect(resolveCliRoute(argv(), HANDLERS)).toEqual({ kind: "wizard" });
  });

  it("dispatches known sub-commands, including flag-shaped ones", () => {
    expect(resolveCliRoute(argv("upgrade", "--channel", "rc"), HANDLERS)).toEqual({
      kind: "handler",
      name: "upgrade",
    });
    expect(resolveCliRoute(argv("--version"), HANDLERS)).toEqual({
      kind: "handler",
      name: "--version",
    });
  });

  it("prints usage for unknown sub-commands, --no-wizard and --help", () => {
    expect(resolveCliRoute(argv("deploy"), HANDLERS)).toEqual({ kind: "usage" });
    expect(resolveCliRoute(argv("--no-wizard"), HANDLERS)).toEqual({ kind: "usage" });
    expect(resolveCliRoute(argv("--help"), HANDLERS)).toEqual({ kind: "usage" });
  });
});

describe("initDelegatesToWizard", () => {
  it("hands every cloud provider to the wizard and keeps self-hosted on init", () => {
    for (const p of ["gcp", "gcp-firebase", "aws", "azure"]) {
      expect(initDelegatesToWizard(p)).toBe(true);
    }
    expect(initDelegatesToWizard("self-hosted")).toBe(false);
  });
});
