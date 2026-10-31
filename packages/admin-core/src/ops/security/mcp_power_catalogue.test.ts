// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1253 — the Power-MCP catalogue is built once per process and plugin
 * tool surface, not 2–3 times per `tools/call` (each build registered ~220
 * tools and turned their schemas into JSON Schema on the event loop).
 */

import { describe, expect, it } from "bun:test";
import { pluginToolsRegistry } from "@caelo-cms/plugin-host";
import { createDefaultToolRegistry, defaultToolRegistry } from "../../ai/tools/index.js";
import { cachedPowerToolCatalogue } from "./mcp_power.js";

/** `WORK_SESSION_ARG` of @caelo-cms/mcp-server (admin-core does not depend on it). */
const WORK_SESSION_ARG = "workSessionId";

describe("Power-MCP catalogue memo (#1253)", () => {
  it("shares one tool registry per process", () => {
    expect(defaultToolRegistry()).toBe(defaultToolRegistry());
    // A caller that needs its own still gets a fresh one.
    expect(createDefaultToolRegistry()).not.toBe(defaultToolRegistry());
  });

  it("returns the same catalogue until the plugin tool surface changes", () => {
    const first = cachedPowerToolCatalogue(true);
    expect(cachedPowerToolCatalogue(true)).toBe(first);
    // The delegated and the opted-in token see different descriptions.
    expect(cachedPowerToolCatalogue(false)).not.toBe(first);

    pluginToolsRegistry.register("t1253-memo", {
      name: "t1253_memo_tool",
      description: "test tool",
      operationName: "noop",
      inputJsonSchema: { type: "object", properties: {} },
    } as never);
    try {
      const rebuilt = cachedPowerToolCatalogue(true);
      expect(rebuilt).not.toBe(first);
      expect(rebuilt.some((t) => t.name === "t1253_memo_tool")).toBe(true);
      expect(cachedPowerToolCatalogue(true)).toBe(rebuilt);
    } finally {
      pluginToolsRegistry.unregisterPlugin("t1253-memo");
    }
    expect(cachedPowerToolCatalogue(true).some((t) => t.name === "t1253_memo_tool")).toBe(false);
  });

  it("no catalogue tool declares the per-call workSessionId itself", () => {
    // The Power-MCP surface adds it to every tool and strips it off the
    // arguments; a tool's own argument of that name would be swallowed.
    for (const tool of cachedPowerToolCatalogue(true)) {
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
      expect(Object.keys(properties ?? {})).not.toContain(WORK_SESSION_ARG);
    }
  });
});
