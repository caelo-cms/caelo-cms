// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — every operation the plugin host registers that admits actor kind
 * `plugin` says what `ctx.cms.call` may do with it (`pluginAccess`,
 * docs/dev/external-plugin-brokers.md §7.1). admin-core's registry has the
 * same test for core's operations.
 */

import { describe, expect, it } from "bun:test";
import { OperationRegistry, pluginAccessOf, pluginAccessProblems } from "@caelo-cms/query-api";
import { registerPluginChangeOps } from "./change-consumers.js";
import { registerCollectionOps } from "./collections-host.js";
import { registerExternalPluginOps } from "./external-ops.js";
import { registerPluginFileOps } from "./file-ops.js";
import { registerPluginFontOps } from "./font-ops.js";
import { registerGatewayOperations } from "./gateway-ops.js";
import { registerPluginImageOps } from "./image-ops.js";
import { registerMailQueueOp } from "./mail-queue.js";
import { registerPluginConfigOps } from "./plugin-config.js";
import { registerPluginSiteMediaOps } from "./site-media-ops.js";
import { registerPluginStorageOps } from "./storage-ops.js";

/** Every operation the admin-side plugin host registers. */
function hostRegistry(): OperationRegistry {
  const registry = new OperationRegistry();
  registerPluginStorageOps(registry);
  registerPluginFileOps(registry);
  registerPluginFontOps(registry);
  registerPluginImageOps(registry);
  registerPluginSiteMediaOps(registry);
  registerPluginConfigOps(registry, { lookup: () => null });
  registerCollectionOps(registry);
  registerMailQueueOp(registry);
  registerPluginChangeOps(registry);
  registerExternalPluginOps(registry);
  return registry;
}

describe("pluginAccess on the plugin host's operations (#1729)", () => {
  it("is declared on every operation that admits plugins", () => {
    const admin = hostRegistry();
    const gateway = new OperationRegistry();
    registerGatewayOperations(gateway);
    expect(pluginAccessProblems(admin)).toEqual([]);
    expect(pluginAccessProblems(gateway)).toEqual([]);
  });

  it("marks the operations behind a plugin's own handles as handle-only", () => {
    const registry = hostRegistry();
    for (const name of [
      "plugin_storage.insert",
      "plugin_changes.cursor_state",
      "plugin_mail.queue",
    ]) {
      const found = registry.lookup(name);
      if (!found.ok) throw new Error(`${name} is not registered`);
      expect(pluginAccessOf(found.value)).toBe("handle");
    }
  });
});
