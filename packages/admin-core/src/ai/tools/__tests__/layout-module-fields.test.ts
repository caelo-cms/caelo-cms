// SPDX-License-Identifier: MPL-2.0

/**
 * issue #106 (step-13 round-5) — layout chrome renders from field DEFAULTS
 * (layout placements have no content_instance binding). The guard rejects a
 * layout module whose fields can't render from a default BEFORE it is created,
 * so the AI re-authors with defaults instead of shipping raw `{{…}}` site-wide
 * and wrongly reaching for content_instances.
 */

import { describe, expect, it } from "bun:test";
import type { ExecutionContext, ModuleField } from "@caelo-cms/shared";
import {
  findUnrenderableLayoutFields,
  unrenderableLayoutFieldsError,
} from "../_layout-module-fields.js";
import { addModuleTool } from "../add-module.js";

describe("findUnrenderableLayoutFields (#106)", () => {
  it("flags a defaultable field that has no default", () => {
    const fields: ModuleField[] = [
      { name: "copyright", kind: "text", label: "Copyright" },
      { name: "nav_links", kind: "link-list", label: "Footer nav" },
    ];
    const problems = findUnrenderableLayoutFields(fields);
    expect(problems.map((p) => p.name).sort()).toEqual(["copyright", "nav_links"]);
  });

  it("passes when every field carries a default", () => {
    const fields: ModuleField[] = [
      { name: "copyright", kind: "text", label: "Copyright", default: "© 2026 Acme" },
      {
        name: "nav_links",
        kind: "link-list",
        label: "Footer nav",
        default: [{ label: "Home", href: "/" }],
      },
    ];
    expect(findUnrenderableLayoutFields(fields)).toEqual([]);
  });

  it("treats an explicit falsy default (empty string / empty list) as present", () => {
    const fields: ModuleField[] = [
      { name: "copyright", kind: "text", label: "Copyright", default: "" },
      { name: "nav_links", kind: "link-list", label: "Footer nav", default: [] },
    ];
    expect(findUnrenderableLayoutFields(fields)).toEqual([]);
  });

  it("flags module / module-list fields — they need a content_instance chrome can't bind", () => {
    const fields: ModuleField[] = [
      { name: "promo", kind: "module", label: "Promo" },
      { name: "cards", kind: "module-list", label: "Cards" },
    ];
    const problems = findUnrenderableLayoutFields(fields);
    expect(problems.map((p) => p.name).sort()).toEqual(["cards", "promo"]);
    expect(problems.every((p) => p.reason.includes("content_instance"))).toBe(true);
  });

  it("is empty for a fully-static module with no fields", () => {
    expect(findUnrenderableLayoutFields(undefined)).toEqual([]);
    expect(findUnrenderableLayoutFields([])).toEqual([]);
  });

  it("error body names the fix and forbids content_instances", () => {
    const msg = unrenderableLayoutFieldsError("add_module", "layout", [
      { name: "copyright", reason: "`copyright` (kind `text`) has no `default`" },
    ]);
    expect(msg).toContain("field DEFAULTS");
    expect(msg).toContain("Do NOT call create_content_instance");
    expect(msg).toContain("add_module");
  });
});

describe("add_module (target='layout') handler enforces the guard (#106)", () => {
  const aiCtx = {
    actorId: "00000000-0000-0000-0000-0000000000a1",
    actorKind: "ai",
    requestId: "layout-guard-test",
  } as unknown as ExecutionContext;

  // A toolCtx whose registry/adapter throw if read — proves the guard rejects
  // BEFORE the handler reaches checkColdStartGate / layouts.get (both of which
  // dereference these). If the guard didn't run first, the test throws loudly.
  const explodingToolCtx = {
    get registry(): never {
      throw new Error("DB touched — guard did not short-circuit");
    },
    get adapter(): never {
      throw new Error("DB touched — guard did not short-circuit");
    },
  } as unknown as Parameters<typeof addModuleTool.handler>[2];

  it("rejects a field with no default, before any DB call", async () => {
    const res = await addModuleTool.handler(
      aiCtx,
      {
        target: "layout",
        targetRef: "site-default",
        blockName: "footer",
        position: "bottom",
        displayName: "Site Footer",
        html: "<footer>{{copyright}}</footer>",
        fields: [{ name: "copyright", kind: "text", label: "Copyright" }],
      },
      explodingToolCtx,
    );
    expect(res.ok).toBe(false);
    expect(res.content).toContain("field DEFAULTS");
    expect(res.content).toContain("copyright");
    expect(res.content).toContain("Do NOT call create_content_instance");
  });

  it("rejects a module-list field on layout chrome", async () => {
    const res = await addModuleTool.handler(
      aiCtx,
      {
        target: "layout",
        targetRef: "site-default",
        blockName: "footer",
        position: 0,
        displayName: "Promo Footer",
        html: "<footer>{{#cards}}…{{/cards}}</footer>",
        fields: [{ name: "cards", kind: "module-list", label: "Cards" }],
      },
      explodingToolCtx,
    );
    expect(res.ok).toBe(false);
    expect(res.content).toContain("content_instance");
  });
});
