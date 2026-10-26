// SPDX-License-Identifier: MPL-2.0

/**
 * e2e-livedit run 40344374447 — the AI sent a template body HTML-escaped
 * as a whole (`&lt;main&gt;…`). The module tools said their `html` / `css`
 * are plain source text; the template and layout tools said nothing. Every
 * tool that takes a template or layout body now states it.
 */

import { describe, expect, it } from "bun:test";
import { MODULE_SOURCE_VALUE_NOTE } from "./_module-js-contract.js";
import { createLayoutTool } from "./create-layout.js";
import { createTemplateTool } from "./create-template.js";
import { createDefaultToolRegistry } from "./index.js";

type Props = Record<string, { description?: string }>;
const propsOf = (schema: unknown): Props =>
  ((schema as { properties?: Props }).properties ?? {}) as Props;

describe("template / layout bodies are plain source text", () => {
  it("the note names entity escaping as wrong", () => {
    expect(MODULE_SOURCE_VALUE_NOTE).toContain("`&lt;div&gt;` is wrong");
  });

  it("every create / update tool for a template or layout states it on html and css", () => {
    const catalogue = createDefaultToolRegistry().catalogue();
    const proposeTools = catalogue.filter((t) =>
      ["propose_update_template", "propose_update_layout"].includes(t.name),
    );
    expect(proposeTools.length).toBe(2);
    for (const schema of [
      createTemplateTool.inputSchema,
      createLayoutTool.inputSchema,
      ...proposeTools.map((t) => t.inputSchema),
    ]) {
      const p = propsOf(schema);
      expect(p.html?.description ?? "").toContain(MODULE_SOURCE_VALUE_NOTE);
      expect(p.css?.description ?? "").toContain(MODULE_SOURCE_VALUE_NOTE);
    }
  });
});
