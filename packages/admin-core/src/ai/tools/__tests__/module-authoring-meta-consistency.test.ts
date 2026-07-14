// SPDX-License-Identifier: MPL-2.0

/**
 * issue #106 (step-13 round-4 deviation) — the three module-authoring tools
 * (add_module_to_page / add_module_to_layout / add_module_to_template) must
 * expose the SAME decision-support metadata (`description`, `kind`, `type`).
 *
 * Root cause of the deviation: only add_module_to_page accepted these keys.
 * The AI authors layout/template chrome with the identical pattern it uses for
 * page modules (CLAUDE.md §1A — one consistent authoring surface), so it passed
 * `kind`/`type`/`description` on the layout tool and the dispatcher rejected the
 * call with `unrecognized_keys`. That is the exact issue-#106 class: a valid AI
 * intent rejected by an inconsistent AI-facing surface.
 *
 * Two guarantees pinned here:
 *  1. ROOT-CAUSE — all three tools' inputSchemas (and the Zod schemas behind
 *     them) accept description/kind/type, so the AI never hits the rejection.
 *  2. RECOVERY — when the AI *does* emit an invalid call, the dispatcher hands
 *     back an AI-actionable error that names the bad keys AND lists the tool's
 *     expected argument set, so the model self-corrects in one turn instead of
 *     punting to the operator (CLAUDE.md §11).
 */

import { describe, expect, it } from "bun:test";
import {
  addModuleToLayoutToolInput,
  addModuleToPageToolInput,
  addModuleToTemplateToolInput,
} from "@caelo-cms/shared";
import { addModuleToLayoutTool } from "../add-module-to-layout.js";
import { addModuleToPageTool } from "../add-module-to-page.js";
import { addModuleToTemplateTool } from "../add-module-to-template.js";
import { createDefaultToolRegistry } from "../index.js";

const META_KEYS = ["description", "kind", "type"] as const;
const KIND_ENUM = ["chrome", "hero", "content", "cta", "utility"];

const TOOLS = [
  { tool: addModuleToPageTool, name: "add_module_to_page" },
  { tool: addModuleToLayoutTool, name: "add_module_to_layout" },
  { tool: addModuleToTemplateTool, name: "add_module_to_template" },
] as const;

describe("module-authoring tools — description/kind/type are consistent (#106)", () => {
  for (const { tool, name } of TOOLS) {
    it(`${name}.inputSchema exposes description/kind/type`, () => {
      const props = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
      for (const key of META_KEYS) {
        expect(props[key]).toBeDefined();
      }
      expect(props.kind.enum).toEqual(KIND_ENUM);
      expect(props.type.pattern).toBe("^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$");
      expect(props.description.type).toBe("string");
    });
  }

  it("all three inputSchemas carry an IDENTICAL meta-prop block (no drift)", () => {
    const metaOf = (s: Record<string, unknown>) => {
      const props = s.properties as Record<string, unknown>;
      return { description: props.description, kind: props.kind, type: props.type };
    };
    const page = metaOf(addModuleToPageTool.inputSchema);
    expect(metaOf(addModuleToLayoutTool.inputSchema)).toEqual(page);
    expect(metaOf(addModuleToTemplateTool.inputSchema)).toEqual(page);
  });
});

describe("module-authoring Zod schemas accept the metadata (#106)", () => {
  const meta = { kind: "chrome", type: "site-footer", description: "global footer" };

  it("addModuleToLayoutToolInput accepts kind/type/description", () => {
    const r = addModuleToLayoutToolInput.safeParse({
      layoutSlug: "site-default",
      blockName: "footer",
      position: "bottom",
      displayName: "Footer",
      html: "<footer>{{copyright}}</footer>",
      ...meta,
    });
    expect(r.success).toBe(true);
  });

  it("addModuleToTemplateToolInput accepts kind/type/description", () => {
    const r = addModuleToTemplateToolInput.safeParse({
      templateId: "00000000-0000-0000-0000-000000000000",
      blockName: "sidebar",
      position: 0,
      displayName: "Sidebar",
      html: "<aside>{{body}}</aside>",
      ...meta,
    });
    expect(r.success).toBe(true);
  });

  it("the same payload still parses on addModuleToPageToolInput (parity)", () => {
    const r = addModuleToPageToolInput.safeParse({
      pageId: "00000000-0000-0000-0000-000000000000",
      blockName: "content",
      position: "top",
      displayName: "Hero",
      html: "<section>{{hero_title}}</section>",
      ...meta,
    });
    expect(r.success).toBe(true);
  });
});

describe("dispatcher rejection is AI-actionable (#106 recovery surface)", () => {
  // The schema-parse failure path returns BEFORE any handler/DB access, so a
  // dummy ctx/toolCtx is never dereferenced.
  const registry = createDefaultToolRegistry();
  const dummyCtx = {} as never;
  const dummyToolCtx = {} as never;

  it("names the unrecognized key AND lists the expected argument set", async () => {
    const res = await registry.dispatch(
      "add_module_to_page",
      {
        pageId: "00000000-0000-0000-0000-000000000000",
        blockName: "content",
        position: "top",
        displayName: "Hero",
        html: "<section>x</section>",
        bogusKey: "nope",
      },
      dummyCtx,
      dummyToolCtx,
    );
    expect(res.ok).toBe(false);
    // names the offending key
    expect(res.content).toContain("bogusKey");
    expect(res.content.toLowerCase()).toContain("unrecognized");
    // hands the model the expected shape so it can self-correct
    expect(res.content).toContain("Expected arguments for `add_module_to_page`");
    expect(res.content).toContain("required:");
    expect(res.content).toContain("optional:");
    // and tells it to retry rather than punt
    expect(res.content.toLowerCase()).toContain("retry");
    // raw Zod JSON is NOT what we hand back anymore
    expect(res.content).not.toContain('"code":"unrecognized_keys"');
  });

  it("a `children` key on a layout tool steers to a `fields` link-list (nesting intent)", async () => {
    const res = await registry.dispatch(
      "add_module_to_layout",
      {
        layoutSlug: "site-default",
        blockName: "header",
        position: "top",
        displayName: "Site Header",
        html: "<header><nav></nav></header>",
        // The observed failure: the model tries to nest a nav via `children`
        // instead of a `fields` link-list, then re-sends it until the loop cap.
        children: [{ type: "nav-link", label: "Home", href: "/" }],
      },
      dummyCtx,
      dummyToolCtx,
    );
    expect(res.ok).toBe(false);
    // names the offending key AND the correct mechanism
    expect(res.content).toContain("children");
    expect(res.content).toContain("`fields`");
    expect(res.content).toContain("link-list");
    // gives a concrete, copyable field example so it re-emits in one turn
    expect(res.content).toContain("nav_links");
    expect(res.content).toContain("{{#nav_links}}");
    // still the generic drop-and-retry guidance
    expect(res.content.toLowerCase()).toContain("retry");
  });

  it("a plain unrelated bad key does NOT trigger the nesting hint", async () => {
    const res = await registry.dispatch(
      "add_module_to_layout",
      {
        layoutSlug: "site-default",
        blockName: "footer",
        position: "bottom",
        displayName: "Footer",
        html: "<footer>x</footer>",
        wobble: 3,
      },
      dummyCtx,
      dummyToolCtx,
    );
    expect(res.ok).toBe(false);
    expect(res.content).toContain("wobble");
    // No nesting-mechanism noise for a non-nesting key.
    expect(res.content).not.toContain("link-list");
    expect(res.content).not.toContain("{{#nav_links}}");
  });
});
