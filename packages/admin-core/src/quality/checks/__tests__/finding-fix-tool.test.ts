// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1751 — a finding's `fix.tool` is a tool name, never free text: a
 * plugin answers it, the chat's fix offer shows it, the audit stores it in
 * jsonb. The pattern is what AI providers accept as a tool name (letters,
 * digits, `_`, `-`), so every tool the AI can call, core's or a shipped
 * plugin's, passes; markup, spaces and half characters do not.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pluginAuditFinding } from "@caelo-cms/plugin-sdk";
import { createDefaultToolRegistry } from "../../../ai/tools/index.js";
import { findingFixSchema } from "../findings.js";

const PLUGINS = resolve(import.meta.dir, "../../../../../plugins");

/** Every `tool: "<name>"` a shipped plugin's source names as a fix. */
function shippedFixTools(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) {
        for (const m of readFileSync(path, "utf8").matchAll(/\btool: "([^"]*)"/g)) {
          out.add(m[1] as string);
        }
      }
    }
  };
  walk(PLUGINS);
  return out;
}

const finding = (tool: string) => ({
  rule: "x",
  severity: "error",
  message: "X: y.",
  fix: { tool, hint: "Do it." },
});

describe("fix.tool is a tool name", () => {
  it("takes every tool of core's catalogue and every fix tool a shipped plugin names", () => {
    const names = [
      ...createDefaultToolRegistry()
        .catalogue()
        .map((t) => t.name),
      ...shippedFixTools(),
    ];
    expect(names.length).toBeGreaterThan(50);
    const refused = names.filter(
      (tool) => !findingFixSchema.safeParse({ tool, hint: "x" }).success,
    );
    expect(refused).toEqual([]);
    const refusedBySdk = names.filter(
      (tool) => !pluginAuditFinding.safeParse(finding(tool)).success,
    );
    expect(refusedBySdk).toEqual([]);
  });

  it("refuses free text, markup and half of a character", () => {
    for (const tool of [
      "update modules",
      "<b>x</b>",
      `tool${"😀".slice(0, 1)}`,
      "",
      "x".repeat(81),
    ]) {
      expect(findingFixSchema.safeParse({ tool, hint: "x" }).success).toBe(false);
      expect(pluginAuditFinding.safeParse(finding(tool)).success).toBe(false);
    }
  });
});
