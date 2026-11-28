// SPDX-License-Identifier: MPL-2.0

/**
 * Data imports — the generated `import_<kind>` tools and the registry's
 * runtime sources (docs/data-imports.md): a tool names its kind's exact
 * fields, stays one object while its kind does, and leaves the catalogue
 * the moment its source drops it.
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { redirectsImportKind } from "../../../data-imports/kinds-redirects.js";
import { formatImportReport, importToolFor } from "../data-import-tools.js";
import { type ToolDefinitionWithHandler, ToolRegistry } from "../dispatch.js";

describe("import_<kind>", () => {
  it("names the kind's fields in the row schema and tells the AI to upload, not to type", () => {
    const tool = importToolFor(redirectsImportKind);
    expect(tool.name).toBe("import_redirects");
    expect(tool).toBe(importToolFor(redirectsImportKind));
    const rows = (
      tool.inputSchema as {
        properties: { rows: { items: { properties: object; required: string[] } } };
      }
    ).properties.rows.items;
    expect(Object.keys(rows.properties)).toEqual(["sourceKey", "fromPath", "toPath", "statusCode"]);
    expect(rows.required).toEqual(["sourceKey", "fromPath", "toPath"]);
    expect(tool.description).toContain("The rows never pass through you");
    expect(tool.description).toContain("sourceKey,fromPath,toPath,statusCode");
  });

  it("formats a report with its counts and the next step", () => {
    const text = formatImportReport({
      importId: "00000000-0000-0000-0000-000000000001",
      kind: "comments",
      dryRun: false,
      written: true,
      counts: { rows: 3, imported: 2, updated: 0, unchanged: 0, invalid: 1 },
      problems: [
        {
          reason: "page-not-found",
          count: 1,
          examples: [{ sourceKey: "wp:3", at: "row 3", detail: "no page at /x" }],
        },
      ],
      state: "draft",
      next: "Next.",
    });
    expect(text).toContain("imported 2");
    expect(text).toContain("page-not-found: 1 rows");
    expect(text).toContain("Next.");
  });
});

describe("ToolRegistry.provide", () => {
  const tool = (name: string): ToolDefinitionWithHandler<unknown> => ({
    name,
    description: name,
    schema: z.object({}).strict() as unknown as z.ZodType<unknown>,
    handler: async () => ({ ok: true, content: name }),
  });

  it("lists, finds and dispatches runtime tools while their source holds them", async () => {
    const registry = new ToolRegistry();
    registry.register(tool("core_tool"));
    let provided = [tool("import_x")];
    registry.provide(() => provided);
    expect(registry.catalogue().map((t) => t.name)).toEqual(["core_tool", "import_x"]);
    expect(registry.get("import_x")?.name).toBe("import_x");
    provided = [];
    expect(registry.get("import_x")).toBeUndefined();
    expect(registry.catalogue().map((t) => t.name)).toEqual(["core_tool"]);
  });

  it("never lets a runtime tool replace a registered one", () => {
    const registry = new ToolRegistry();
    registry.register(tool("same"));
    registry.provide(() => [{ ...tool("same"), description: "shadow" }]);
    expect(registry.get("same")?.description).toBe("same");
  });
});
