// SPDX-License-Identifier: MPL-2.0

/**
 * issue #106 + audit #2 — the module-authoring surface must expose the
 * decision-support metadata (`description`, `kind`, `type`) AND fail loudly +
 * actionably when the model emits an invalid call.
 *
 * History: this originally pinned that the THREE tools
 * (add_module_to_{page,layout,template}) carried an identical meta block —
 * the drift that produced the #106 footer bug. Audit #2 collapsed them into a
 * single `add_module` routed by `target`, so "consistency across three tools"
 * is now structural (there is one schema). What remains worth pinning:
 *
 *  1. ROOT-CAUSE — `add_module`'s inputSchema (and the Zod schema behind it)
 *     accepts description/kind/type on every target, so the AI's one authoring
 *     pattern (CLAUDE.md §1A) is never rejected with `unrecognized_keys`.
 *  2. RECOVERY — an invalid call hands back an AI-actionable error naming the
 *     bad key + the expected argument set, and a nesting-intent key (`children`)
 *     steers the model to a `fields` link-list instead (CLAUDE.md §11).
 */

import { describe, expect, it } from "bun:test";
import { addModuleToolInput } from "@caelo-cms/shared";
import { addModuleTool } from "../add-module.js";
import { createDefaultToolRegistry } from "../index.js";

const META_KEYS = ["description", "kind", "type"] as const;
const KIND_ENUM = ["chrome", "hero", "content", "cta", "utility"];

describe("add_module — description/kind/type are exposed (#106)", () => {
  it("inputSchema exposes description/kind/type", () => {
    const props = addModuleTool.inputSchema.properties as Record<string, Record<string, unknown>>;
    for (const key of META_KEYS) {
      expect(props[key]).toBeDefined();
    }
    expect(props.kind.enum).toEqual(KIND_ENUM);
    expect(props.type.pattern).toBe("^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$");
    expect(props.description.type).toBe("string");
  });
});

describe("addModuleToolInput accepts the metadata on every target (#106)", () => {
  const meta = { kind: "chrome", type: "site-footer", description: "global footer" };

  it("target='layout' accepts kind/type/description", () => {
    const r = addModuleToolInput.safeParse({
      target: "layout",
      targetRef: "site-default",
      blockName: "footer",
      position: "bottom",
      displayName: "Footer",
      html: "<footer>{{copyright}}</footer>",
      ...meta,
    });
    expect(r.success).toBe(true);
  });

  it("target='template' accepts kind/type/description", () => {
    const r = addModuleToolInput.safeParse({
      target: "template",
      targetRef: "00000000-0000-0000-0000-000000000000",
      blockName: "sidebar",
      position: 0,
      displayName: "Sidebar",
      html: "<aside>{{body}}</aside>",
      ...meta,
    });
    expect(r.success).toBe(true);
  });

  it("target='page' accepts kind/type/description", () => {
    const r = addModuleToolInput.safeParse({
      target: "page",
      targetRef: "home",
      blockName: "content",
      position: "top",
      displayName: "Hero",
      html: "<section>{{hero_title}}</section>",
      ...meta,
    });
    expect(r.success).toBe(true);
  });

  it("reuse mode (moduleId) rejects authoring fields as mutually exclusive", () => {
    const r = addModuleToolInput.safeParse({
      target: "layout",
      targetRef: "site-default",
      blockName: "footer",
      position: "bottom",
      moduleId: "00000000-0000-0000-0000-000000000000",
      html: "<footer>x</footer>",
    });
    expect(r.success).toBe(false);
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
      "add_module",
      {
        target: "page",
        targetRef: "home",
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
    expect(res.content).toContain("Expected arguments for `add_module`");
    expect(res.content).toContain("required:");
    expect(res.content).toContain("optional:");
    // and tells it to retry rather than punt
    expect(res.content.toLowerCase()).toContain("retry");
    // raw Zod JSON is NOT what we hand back anymore
    expect(res.content).not.toContain('"code":"unrecognized_keys"');
  });

  it("a `children` key steers to a `fields` link-list (nesting intent)", async () => {
    const res = await registry.dispatch(
      "add_module",
      {
        target: "layout",
        targetRef: "site-default",
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
      "add_module",
      {
        target: "layout",
        targetRef: "site-default",
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
