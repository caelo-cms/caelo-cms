// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_COMMANDS, cliUsage, initDelegatesToWizard, resolveCliRoute } from "./cli-routing.js";

const HANDLERS = ["init", "upgrade", "wizard", "version", "--version", "-v"];
const argv = (...rest: string[]) => ["bun", "cli.js", ...rest];

describe("resolveCliRoute", () => {
  it("routes the documented flags-only invocation to the wizard", () => {
    expect(
      resolveCliRoute(argv("--provider", "gcp-firebase", "--domain", "example.com"), HANDLERS),
    ).toEqual({ kind: "wizard" });
  });

  it("routes the self-hosted one-command install to init (#707)", () => {
    expect(
      resolveCliRoute(
        argv("--provider", "self-hosted", "--domain", "example.com", "--owner-email", "o@x.y"),
        HANDLERS,
      ),
    ).toEqual({ kind: "handler", name: "init" });
    expect(resolveCliRoute(argv("--provider", "self-hosted", "--help"), HANDLERS)).toEqual({
      kind: "usage",
    });
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

describe("CLI_COMMANDS / cliUsage", () => {
  it("prints the usage line operators already know, built from the catalogue", () => {
    expect(cliUsage().split("\n")[0]).toBe(
      "Usage: cms-provision [wizard] [--provider <name> --domain <d> [--staging-domain <host>] --owner-email <e> --region <r>] [--local|--install-job] | <init|up|migrate|status|upgrade|backup|restore|rotate-secret|truncate|destroy|regenerate-caddy|admin-domain|staging-domain|owner-reset|state migrate|attach|pulumi-output-sync|version> [options]",
    );
  });

  it("documents only sub-commands cli.ts actually dispatches", () => {
    const cliSource = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");
    const handlerBlock = cliSource.slice(cliSource.indexOf("const handlers"));
    for (const c of CLI_COMMANDS) {
      const head = c.name.split(" ")[0] as string;
      expect(handlerBlock).toMatch(new RegExp(`\\n\\s+"?${head}"?[:,]`));
    }
  });

  it("gives every command a one-sentence summary", () => {
    for (const c of CLI_COMMANDS) {
      expect(c.summary.length).toBeGreaterThan(10);
      expect(c.summary.endsWith(".")).toBe(true);
    }
  });
});
