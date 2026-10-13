// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { bundledChromiumLaunchOptions } from "./screenshot.js";

describe("bundledChromiumLaunchOptions", () => {
  it("keeps the back/forward cache on for the Lighthouse audit browser (#667)", () => {
    // Playwright's default --disable-back-forward-cache made Lighthouse's
    // bf-cache audit fail on every page of every site.
    const opts = bundledChromiumLaunchOptions(9333);
    expect(opts.ignoreDefaultArgs).toEqual(["--disable-back-forward-cache"]);
    expect(opts.args).toEqual([
      "--remote-debugging-port=9333",
      "--remote-debugging-address=127.0.0.1",
    ]);
    expect(opts.args?.some((a) => a.includes("back-forward-cache"))).toBe(false);
  });

  it("leaves Playwright's defaults alone without a DevTools port (screenshots)", () => {
    expect(bundledChromiumLaunchOptions()).toEqual({ headless: true, channel: "chromium" });
  });
});
