// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  describePluginProblems,
  describeStagedPluginProblems,
  stagedWithoutPlugins,
} from "../plugin-problems.js";

describe("stagedWithoutPlugins", () => {
  it("lets a Stage through that recorded every active plugin running", () => {
    expect(stagedWithoutPlugins([])).toBeNull();
  });

  it("refuses a Stage built while a plugin was not running", () => {
    expect(stagedWithoutPlugins([{ slug: "international-site", reason: "x" }])).toContain(
      '"international-site" was not running',
    );
  });

  it("refuses a Stage from before plugin health was recorded, or with a broken record", () => {
    for (const recorded of [null, undefined, "nope", [{ slug: 1 }]]) {
      expect(stagedWithoutPlugins(recorded)).toContain("Stage again");
    }
  });
});

describe("describePluginProblems", () => {
  it("names every plugin and the way out", () => {
    const m = describePluginProblems([
      { slug: "forms", reason: "not running on this server: boom" },
      { slug: "ratings", reason: "not loading on another server: bang" },
    ]);
    expect(m).toContain("2 active plugins are not running");
    expect(m).toContain('"forms" (not running on this server: boom)');
    expect(m).toContain("reload_plugin");
    expect(m).toContain("Stage again");
  });
});

describe("describeStagedPluginProblems", () => {
  it("says nothing when every active plugin ran", () => {
    expect(describeStagedPluginProblems([])).toBeNull();
  });

  it("names each plugin, that Publish live refuses the Stage, and the way out", () => {
    const m = describeStagedPluginProblems([
      { slug: "forms", reason: "not running on this server: boom" },
    ]);
    expect(m).toContain('"forms" (not running on this server: boom)');
    expect(m).toContain("Publish live will refuse this Stage");
    expect(m).toContain("reload_plugin");
    expect(m).toContain("Stage again");
  });
});
