// SPDX-License-Identifier: MPL-2.0

/**
 * Regression (e2e-livedit 2026-10, four auto-filed reports): the AI was
 * offered `inspect_built_page` on a non-GCP install and every call failed
 * with "only available on GCP installs". A tool that cannot run on this
 * install must not be in the AI's catalogue at all.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { powerToolCatalogue } from "../../../ops/security/mcp_power.js";
import { resolveExcludedToolNames } from "../../chat-runner/tool-catalogue.js";
import { createDefaultToolRegistry } from "../index.js";
import { installUnavailableToolNames, isGcpInstall } from "../install-availability.js";

const ORIGINAL_PROVIDER = process.env.CAELO_PROVIDER;

afterEach(() => {
  if (ORIGINAL_PROVIDER === undefined) delete process.env.CAELO_PROVIDER;
  else process.env.CAELO_PROVIDER = ORIGINAL_PROVIDER;
});

describe("installUnavailableToolNames", () => {
  it("treats both GCP install kinds as GCP", () => {
    expect(isGcpInstall({ CAELO_PROVIDER: "gcp" })).toBe(true);
    expect(isGcpInstall({ CAELO_PROVIDER: "gcp-firebase" })).toBe(true);
    expect(isGcpInstall({ CAELO_PROVIDER: "self-hosted" })).toBe(false);
    expect(isGcpInstall({})).toBe(false);
  });

  it("marks inspect_built_page unavailable off GCP only", () => {
    expect(installUnavailableToolNames({ CAELO_PROVIDER: "aws" }).has("inspect_built_page")).toBe(
      true,
    );
    expect(installUnavailableToolNames({}).has("inspect_built_page")).toBe(true);
    expect(installUnavailableToolNames({ CAELO_PROVIDER: "gcp" }).size).toBe(0);
    expect(installUnavailableToolNames({ CAELO_PROVIDER: "gcp-firebase" }).size).toBe(0);
  });

  it("names only tools that are registered (no drift)", () => {
    const registered = new Set(
      createDefaultToolRegistry()
        .list()
        .map((t) => t.name),
    );
    for (const name of installUnavailableToolNames({})) expect(registered.has(name)).toBe(true);
  });
});

describe("chat catalogue exclusion", () => {
  it("excludes inspect_built_page from every chat turn off GCP", () => {
    process.env.CAELO_PROVIDER = "self-hosted";
    expect(resolveExcludedToolNames(undefined, false)?.has("inspect_built_page")).toBe(true);
    expect(resolveExcludedToolNames(undefined, true)?.has("inspect_built_page")).toBe(true);
  });

  it("keeps inspect_built_page on GCP installs", () => {
    process.env.CAELO_PROVIDER = "gcp-firebase";
    expect(resolveExcludedToolNames(undefined, false)?.has("inspect_built_page")).toBe(false);
  });
});

describe("Power-MCP catalogue", () => {
  it("leaves out the tools the install cannot run", () => {
    const names = powerToolCatalogue(createDefaultToolRegistry(), {
      unavailable: installUnavailableToolNames({ CAELO_PROVIDER: "self-hosted" }),
    }).map((t) => t.name);
    expect(names).not.toContain("inspect_built_page");
    expect(names).toContain("inspect_page_render");
  });
});
