// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { ok } from "@caelo-cms/shared";
import { z } from "zod";
import {
  defineOperation,
  OperationRegistry,
  type PluginAccess,
  pluginOperationAllowlistRefusal,
} from "../index.js";

function op(name: string, actorScope: readonly string[], pluginAccess?: PluginAccess) {
  return defineOperation({
    name,
    readScope: "request",
    actorScope: actorScope as never,
    ...(pluginAccess ? { pluginAccess } : {}),
    database: "cms_admin",
    input: z.object({}),
    output: z.object({}),
    handler: async () => ok({}),
  });
}

const registry = new OperationRegistry();
registry.register(op("pages.list", ["human", "ai", "plugin", "system"], "read"));
registry.register(op("pages.update", ["human", "ai", "plugin", "system"], "write"));
registry.register(op("deploy.trigger", ["human", "ai", "system"]));
registry.register(op("plugin_storage.insert", ["plugin"], "handle"));

describe("#1729 — a cms_admin allowlist names only operations a plugin can call", () => {
  it("accepts reads and writes open to plugins", () => {
    expect(pluginOperationAllowlistRefusal(registry, ["pages.list", "pages.update"])).toBeNull();
    expect(pluginOperationAllowlistRefusal(registry, [])).toBeNull();
  });

  it("refuses an unknown name, a closed operation and a handle, naming each and the next step", () => {
    const refusal = pluginOperationAllowlistRefusal(registry, [
      "pages.list",
      "pages.nope",
      "deploy.trigger",
      "plugin_storage.insert",
    ]);
    expect(refusal).toContain("pages.nope is not an operation of this site");
    expect(refusal).toContain("deploy.trigger is not open to plugins");
    expect(refusal).toContain("plugin_storage.insert backs a plugin handle");
    expect(refusal).toContain("Remove them from the allowlist and submit the package again");
    expect(refusal).not.toContain("pages.list,");
  });
});
