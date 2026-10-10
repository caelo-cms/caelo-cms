// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { pluginsActivatedDuring } from "./plugin-isolation.js";

describe("pluginsActivatedDuring", () => {
  it("returns what the test switched on (the consent scenario case)", () => {
    expect(pluginsActivatedDuring([], ["consent-manager"])).toEqual(["consent-manager"]);
  });

  it("leaves plugins alone that were already active before the test", () => {
    // A warm local DB may run with a plugin on; the guard restores what the
    // test changed, it does not impose its own idea of a baseline.
    expect(pluginsActivatedDuring(["analytics"], ["analytics", "consent-manager"])).toEqual([
      "consent-manager",
    ]);
  });

  it("is empty when nothing changed or a plugin was switched off", () => {
    expect(pluginsActivatedDuring(["a"], ["a"])).toEqual([]);
    expect(pluginsActivatedDuring(["a"], [])).toEqual([]);
  });

  it("is sorted and deduplicated", () => {
    expect(
      pluginsActivatedDuring([], ["international-site", "consent-manager", "consent-manager"]),
    ).toEqual(["consent-manager", "international-site"]);
  });
});
