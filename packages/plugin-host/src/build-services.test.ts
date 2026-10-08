// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  BUILD_PLUGIN_METHODS,
  type BuildPluginServices,
  decodeBuildPayload,
  encodeBuildPayload,
  remoteBuildPluginServices,
  serveBuildPluginCall,
} from "./build-services.js";

describe("build plugin payload codec (#605)", () => {
  it("round-trips nested Maps — the shape of page-keyed answers", () => {
    const value = {
      lists: new Map([["p1", { language_links: [{ href: "/de/", locale: "de" }] }]]),
      variants: new Map([
        ["p1", new Map([["layout:footer:0", { pluginSlug: "x", problems: [] }]])],
      ]),
      plain: [1, "two", null],
    };
    const back = decodeBuildPayload(encodeBuildPayload(value)) as typeof value;
    expect(back.lists).toBeInstanceOf(Map);
    expect(back.lists.get("p1")).toEqual({ language_links: [{ href: "/de/", locale: "de" }] });
    expect(back.variants.get("p1")?.get("layout:footer:0")).toEqual({
      pluginSlug: "x",
      problems: [],
    });
    expect(back.plain).toEqual([1, "two", null]);
  });

  it("leaves ordinary content that uses a tag key alone", () => {
    const value = {
      text: { __caeloMap: "just text" },
      pairs: { __caeloMap: [["a", 1]] },
      nested: { __caeloObject: [["x", { __caeloMap: [] }]] },
    };
    expect(decodeBuildPayload(encodeBuildPayload(value))).toEqual(value);
  });
});

describe("remote ↔ served build plugin calls", () => {
  /** Services that echo what they were asked, so the wire is observable. */
  const echo = Object.fromEntries(
    BUILD_PLUGIN_METHODS.map((m) => [m, async (...args: unknown[]) => ({ m, args })]),
  ) as unknown as BuildPluginServices;

  it("forwards every method with its arguments through one channel", async () => {
    // The channel the CLI uses: encode → (stdio) → decode → serve → encode → decode.
    const remote = remoteBuildPluginServices(async (method, args) => {
      const wire = decodeBuildPayload(encodeBuildPayload({ method, args })) as {
        method: string;
        args: unknown[];
      };
      const value = await serveBuildPluginCall(wire.method, wire.args, echo);
      return decodeBuildPayload(encodeBuildPayload(value));
    });
    expect(await remote.staticRender("international-site", "p1", "directory")).toEqual({
      m: "staticRender",
      args: ["international-site", "p1", "directory"],
    } as unknown as string);
    expect(await remote.declaredDataListNames()).toEqual({
      m: "declaredDataListNames",
      args: [],
    } as unknown as string[]);
  });

  it("refuses a method outside the build surface", async () => {
    await expect(serveBuildPluginCall("runPluginOperation", [], echo)).rejects.toThrow(
      "unknown method",
    );
    await expect(serveBuildPluginCall("staticRender", "not-an-array", echo)).rejects.toThrow(
      "must be an array",
    );
  });
});
