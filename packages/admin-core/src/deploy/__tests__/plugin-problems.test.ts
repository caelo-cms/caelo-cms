// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { describePluginProblems, stagedWithoutPlugins } from "../plugin-problems.js";

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
