// SPDX-License-Identifier: MPL-2.0

/**
 * The retired-tool alias layer (retired-tools.ts): every retired singular
 * name and every renamed bulk wrapper key still lands on the live tool with
 * arguments that tool's Zod schema accepts, through every seam that consults
 * the table — the registry (`get` / `dispatch`), skill allowlists, subagent
 * tool lists — while the aliases stay out of the catalogue and the core set.
 */

import { describe, expect, it } from "bun:test";
import { type DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { registerAdminOps } from "../../../register.js";
import {
  resolveAllowlistEntry,
  validateAllowlistEntries,
} from "../../chat-runner/allowlist-mapping.js";
import { CORE_TOOL_NAMES } from "../core-tools.js";
import type { ToolContext } from "../dispatch.js";
import { createDefaultToolRegistry } from "../index.js";
import {
  ARG_RENAMES,
  canonicalToolNames,
  liveToolNameFor,
  RETIRED_TOOLS,
  resolveToolCall,
} from "../retired-tools.js";

const PAGE = "11111111-1111-4111-8111-111111111101";
const MODULE = "11111111-1111-4111-8111-111111111102";
const INSTANCE = "11111111-1111-4111-8111-111111111103";
const ASSET = "11111111-1111-4111-8111-111111111104";

/** A representative call per retired tool, exactly as the old tool took it. */
const OLD_CALLS: Record<string, Record<string, unknown>> = {
  edit_module: {
    moduleId: MODULE,
    html: "<h1>{{hero_title}}</h1>",
    fields: [{ name: "hero_title", kind: "text", label: "Hero title" }],
    bindThemeLiterals: false,
  },
  set_content_instance_values: { id: INSTANCE, values: { hero_title: "Hi" }, purpose: "Footer" },
  set_page_module_content: {
    pageId: PAGE,
    blockName: "content",
    position: 0,
    contentValues: { hero_title: "Hi" },
  },
  create_content_instance: {
    moduleId: MODULE,
    purpose: "Footer CTA on product pages",
    values: { cta_label: "Start" },
  },
  autofill_page_seo: { pageId: PAGE, metaDescription: "A page about things." },
  delete_content_instance: { id: INSTANCE },
  set_page_seo: { pageId: PAGE, noindex: true },
  set_media_alt: { assetId: ASSET, alt: "A red bicycle" },
  set_media_source: { assetId: ASSET, sourceKind: "upload" },
  optimize_page_seo: {
    pageId: PAGE,
    metaDescription: "Sharper description.",
    context: "keyword: bikes",
  },
  reorder_module: { pageId: PAGE, moduleId: MODULE, direction: "up" },
};

/** A representative call per renamed key, with the OLD wrapper key. */
const OLD_KEY_CALLS: Record<string, Record<string, unknown>> = {
  update_modules_many: { updates: [{ moduleId: MODULE, css: ".hero{color:red}" }] },
  update_pages_many: { updates: [{ pageId: PAGE, title: "About" }] },
  delete_pages_many: { deletions: [{ pageId: PAGE, disposition: "404" }] },
  bulk_optimize_seo: { updates: [{ pageId: PAGE, metaDescription: "x" }], context: "c" },
  bulk_create_redirects: { redirects: [{ fromPath: "/a", toPath: "/b" }] },
  create_content_instances: { instances: [{ moduleId: MODULE, values: {} }] },
};

const live = createDefaultToolRegistry();
const isLive = (n: string) => live.list().some((t) => t.name === n);

describe("RETIRED_TOOLS", () => {
  it("covers exactly the eleven retired names, none of them registered", () => {
    expect(Object.keys(RETIRED_TOOLS).sort()).toEqual(Object.keys(OLD_CALLS).sort());
    for (const name of Object.keys(RETIRED_TOOLS)) expect(isLive(name)).toBe(false);
  });

  for (const [oldName, args] of Object.entries(OLD_CALLS)) {
    it(`${oldName}: adapts an old call into one ${RETIRED_TOOLS[oldName]?.target} accepts`, () => {
      const retired = RETIRED_TOOLS[oldName];
      expect(retired).toBeDefined();
      if (!retired) return;
      const target = live.get(retired.target);
      expect(target?.name).toBe(retired.target);
      const parsed = target?.schema.safeParse(retired.adapt(args));
      expect(parsed?.success).toBe(true);
    });
  }

  it("optimize_page_seo moves its per-call context next to items", () => {
    const adapted = RETIRED_TOOLS.optimize_page_seo?.adapt(OLD_CALLS.optimize_page_seo);
    expect(adapted).toEqual({
      items: [{ pageId: PAGE, metaDescription: "Sharper description." }],
      context: "keyword: bikes",
    });
  });

  it("reorder_module becomes move_module in the current block (no toBlockName)", () => {
    const adapted = RETIRED_TOOLS.reorder_module?.adapt({
      pageId: PAGE,
      moduleId: MODULE,
      direction: 2,
    });
    expect(adapted).toEqual({ pageId: PAGE, moduleId: MODULE, position: 2 });
  });

  it("passes a non-object argument through for the target's own Zod error", () => {
    expect(RETIRED_TOOLS.set_media_alt?.adapt("oops")).toEqual({ items: ["oops"] });
    const parsed = live.get("set_media_alt_many")?.schema.safeParse({ items: ["oops"] });
    expect(parsed?.success).toBe(false);
  });
});

describe("ARG_RENAMES", () => {
  it("lists only live tools whose new key is `items`", () => {
    for (const [tool, renames] of Object.entries(ARG_RENAMES)) {
      expect(isLive(tool)).toBe(true);
      for (const to of Object.values(renames)) expect(to).toBe("items");
      const props = (live.get(tool)?.inputSchema.properties ?? {}) as Record<string, unknown>;
      expect(props.items).toBeDefined();
      for (const from of Object.keys(renames)) expect(props[from]).toBeUndefined();
    }
  });

  for (const [tool, args] of Object.entries(OLD_KEY_CALLS)) {
    it(`${tool}: an old-key call resolves to one the schema accepts`, () => {
      const resolved = resolveToolCall(tool, args, isLive, "test");
      expect(resolved?.renamedKeys.length).toBe(1);
      expect(live.get(tool)?.schema.safeParse(resolved?.args).success).toBe(true);
    });
  }

  it("leaves a call carrying both the old and the new key for Zod to reject", () => {
    const args = { items: [], updates: [] };
    const resolved = resolveToolCall("update_modules_many", args, isLive, "test");
    expect(resolved?.args).toBe(args);
    expect(resolved?.renamedKeys).toEqual([]);
  });
});

describe("resolveToolCall", () => {
  it("maps a retired name to its target and records where it came from", () => {
    const r = resolveToolCall("edit_module", OLD_CALLS.edit_module, isLive, "test");
    expect(r?.name).toBe("update_modules_many");
    expect(r?.retiredFrom).toBe("edit_module");
    expect(r?.args).toEqual({ items: [OLD_CALLS.edit_module] });
  });

  it("returns null for a name that is neither live nor retired", () => {
    expect(resolveToolCall("no_such_tool", {}, isLive, "test")).toBeNull();
  });

  it("returns null when the retired target is not available (narrowed tool set)", () => {
    expect(resolveToolCall("set_page_seo", {}, (n) => n === "list_pages", "test")).toBeNull();
  });

  it("passes a live name with current keys through untouched", () => {
    const args = { items: [{ assetId: ASSET, alt: "x" }] };
    const r = resolveToolCall("set_media_alt_many", args, isLive, "test");
    expect(r).toEqual({ name: "set_media_alt_many", args, renamedKeys: [] });
  });
});

describe("hidden from the catalogue", () => {
  it("no retired name is in catalogue(), list() or the core set", () => {
    const names = new Set(live.catalogue().map((t) => t.name));
    for (const name of Object.keys(RETIRED_TOOLS)) {
      expect(names.has(name)).toBe(false);
      expect(CORE_TOOL_NAMES.has(name)).toBe(false);
    }
  });

  it("every core tool is registered; inspect_built_page stays registered but deferred", () => {
    for (const name of CORE_TOOL_NAMES) expect(isLive(name)).toBe(true);
    expect(CORE_TOOL_NAMES.has("inspect_built_page")).toBe(false);
    expect(isLive("inspect_built_page")).toBe(true);
  });
});

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "retired-tools-unit",
};

function recordingToolCtx(calls: { op: string; input: unknown }[]): ToolContext {
  const registry = new OperationRegistry();
  registerAdminOps(registry);
  const adapter = {
    runOperation: async (op: { name: string }, _ctx: unknown, input: unknown) => {
      // #1157 — the redirect tools read where the saved redirects are live.
      if (op.name === "redirects.sync_status") return ok({ targets: [] });
      calls.push({ op: op.name, input });
      return ok({ results: [{}], count: 1 });
    },
  } as unknown as DatabaseAdapter;
  return { adapter, registry } as ToolContext;
}

describe("ToolRegistry alias resolution", () => {
  it("get() resolves a retired name to the tool that replaced it", () => {
    expect(live.get("set_media_alt")?.name).toBe("set_media_alt_many");
    expect(live.get("reorder_module")?.name).toBe("move_module");
    expect(live.get("no_such_tool")).toBeUndefined();
  });

  it("dispatch() runs a retired-name call as the bulk tool, through its op", async () => {
    const calls: { op: string; input: unknown }[] = [];
    const res = await live.dispatch(
      "set_media_alt",
      { assetId: ASSET, alt: "A red bicycle" },
      AI,
      recordingToolCtx(calls),
    );
    expect(res.ok).toBe(true);
    expect(calls).toEqual([
      { op: "media.update_alt_many", input: { items: [{ assetId: ASSET, alt: "A red bicycle" }] } },
    ]);
  });

  it("dispatch() renames an old wrapper key before the strict parse", async () => {
    const calls: { op: string; input: unknown }[] = [];
    const res = await live.dispatch(
      "bulk_create_redirects",
      { redirects: [{ fromPath: "/a", toPath: "/b" }] },
      AI,
      recordingToolCtx(calls),
    );
    expect(res.content).not.toContain("unknown tool");
    expect(calls[0]?.op).toBe("redirects.create_many");
    expect((calls[0]?.input as { redirects?: unknown[] } | undefined)?.redirects).toHaveLength(1);
  });

  it("dispatch() still reports a genuinely unknown tool", async () => {
    const res = await live.dispatch("no_such_tool", {}, AI, recordingToolCtx([]));
    expect(res).toEqual({
      ok: false,
      content: "unknown tool: no_such_tool",
      failureKind: "UnknownTool",
    });
  });
});

describe("skill allowlists (`retired` resolution)", () => {
  const liveNames = new Set(live.list().map((t) => t.name));

  it("resolves a retired entry to its replacement", () => {
    expect(resolveAllowlistEntry("edit_module", liveNames)).toEqual({
      kind: "retired",
      toolNames: ["update_modules_many"],
    });
  });

  it("normalizes retired names on save, deduplicated against the live name", () => {
    const r = validateAllowlistEntries(
      ["edit_module", "update_modules_many", "reorder_module"],
      liveNames,
    );
    expect(r).toEqual({ ok: true, normalized: ["update_modules_many", "move_module"] });
  });

  it("is unresolved (with the replacement as hint) when the target is not live", () => {
    expect(resolveAllowlistEntry("edit_module", new Set(["list_pages"]))).toEqual({
      kind: "unresolved",
      suggestion: "update_modules_many",
    });
  });
});

describe("tool-name lists (subagent allowedToolNames)", () => {
  it("canonicalToolNames maps retired names, keeps order, drops duplicates", () => {
    expect(
      canonicalToolNames(
        ["list_pages", "edit_module", "update_modules_many", "set_media_alt"],
        "t",
      ),
    ).toEqual(["list_pages", "update_modules_many", "set_media_alt_many"]);
  });

  it("liveToolNameFor is the identity for live and unknown names", () => {
    expect(liveToolNameFor("list_pages")).toBe("list_pages");
    expect(liveToolNameFor("no_such_tool")).toBe("no_such_tool");
  });
});
