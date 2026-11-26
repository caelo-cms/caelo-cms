// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — the rules of `ctx.cms.call`, one set for every plugin
 * (docs/dev/external-plugin-brokers.md §7.1, decisions Q2 and Q9): only
 * operations open to plugins and not behind a handle, nothing written from
 * a render, site-wide reads only in background work, and only the
 * operations an installed plugin's receipt names.
 */

import { describe, expect, it } from "bun:test";
import type { PluginInvocation } from "@caelo-cms/plugin-sdk";
import { defineOperation, OperationRegistry } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { z } from "zod";
import { pluginCmsRefusal } from "./capabilities.js";

const ID = "11111111-1111-4111-8111-111111111111";

function op(
  name: string,
  extra: {
    actorScope?: ("human" | "ai" | "system" | "plugin")[];
    pluginAccess?: "read" | "write" | "handle";
    readScope?: "request" | "site";
  },
) {
  return defineOperation({
    name,
    actorScope: extra.actorScope ?? ["system", "plugin"],
    readScope: extra.readScope ?? "request",
    ...(extra.pluginAccess ? { pluginAccess: extra.pluginAccess } : {}),
    database: "cms_admin",
    input: z.object({}).passthrough(),
    output: z.unknown(),
    handler: async () => ok({}),
  });
}

const registry = new OperationRegistry();
for (const o of [
  op("pages.list", { pluginAccess: "read" }),
  op("pages.update", { pluginAccess: "write" }),
  op("plugin_storage.insert", { actorScope: ["plugin"], pluginAccess: "handle" }),
  op("sites.export", { pluginAccess: "read", readScope: "site" }),
  op("users.list", { actorScope: ["human", "system"] }),
  op("pages.unmarked", {}),
]) {
  registry.register(o as never);
}

const at = (origin: PluginInvocation["origin"], extra: Partial<PluginInvocation> = {}) =>
  ({ origin, actorId: ID, ...extra }) as PluginInvocation;
const refusal = (
  name: string,
  invocation: PluginInvocation,
  options: Parameters<typeof pluginCmsRefusal>[4] = {},
) => pluginCmsRefusal(registry, "probe", name, invocation, options);

describe("ctx.cms.call rules (#1729)", () => {
  it("runs reads on every origin, a render included", () => {
    expect(refusal("pages.list", at("render"))).toBeNull();
    expect(refusal("pages.list", at("chat", { chatBranchId: ID }))).toBeNull();
  });

  it("refuses a write from a render, for every plugin, and allows it elsewhere", () => {
    expect(refusal("pages.update", at("render"))).toContain("a render only reads");
    expect(refusal("pages.update", at("worker"))).toBeNull();
    expect(refusal("pages.update", at("chat", { chatBranchId: ID }))).toBeNull();
  });

  it("refuses operations behind a plugin's own handles, unknown ones and closed ones", () => {
    expect(refusal("plugin_storage.insert", at("worker"))).toContain("through that handle");
    expect(refusal("pages.nothing", at("worker"))).toContain("no operation of that name");
    expect(refusal("users.list", at("worker"))).toContain("does not admit them");
    expect(refusal("pages.unmarked", at("worker"))).toContain("bug_report");
  });

  it("lets only background work read the whole site", () => {
    expect(refusal("sites.export", at("chat", { chatBranchId: ID }))).toContain(
      "only background work",
    );
    expect(refusal("sites.export", at("render"))).toContain("only background work");
    expect(refusal("sites.export", at("system"), { kind: "journal" })).toContain(
      "only background work",
    );
    expect(refusal("sites.export", at("worker"))).toBeNull();
    expect(refusal("sites.export", at("batch"))).toBeNull();
    expect(refusal("sites.export", at("system"), { kind: "rebuild" })).toBeNull();
  });

  it("holds an installed plugin to the operations its receipt names", () => {
    const allowed = new Set(["pages.list"]);
    expect(refusal("pages.list", at("worker"), { allowed })).toBeNull();
    expect(refusal("pages.update", at("worker"), { allowed })).toContain(
      "not among the operations the Owner approved",
    );
    // An empty list (a receipt that names nothing) refuses everything.
    expect(refusal("pages.list", at("worker"), { allowed: new Set() })).toContain(
      "not among the operations",
    );
  });
});
