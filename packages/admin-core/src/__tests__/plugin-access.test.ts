// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — every core operation that admits actor kind `plugin` says what
 * a plugin's `ctx.cms.call` may do with it (`pluginAccess`: read, write or
 * handle; docs/dev/external-plugin-brokers.md §7.1). A render may only read,
 * so a new plugin-open operation without the marker would be a hole.
 * Unit tier: the registry only, no database.
 */

import { describe, expect, it } from "bun:test";
import { OperationRegistry, pluginAccessOf, pluginAccessProblems } from "@caelo-cms/query-api";
import { registerAdminOps } from "../register.js";

describe("pluginAccess on core operations (#1729)", () => {
  const registry = new OperationRegistry();
  registerAdminOps(registry);

  it("is declared on every operation that admits plugins", () => {
    expect(pluginAccessProblems(registry)).toEqual([]);
  });

  it("marks the core writes shipped plugins make as writes", () => {
    for (const name of [
      "pages.update",
      "pages.duplicate",
      "pages.refresh_current_path",
      "page_module_content.set",
      "pages_seo.apply_translation",
      "placement.fork_paths",
      "redirects.create",
    ]) {
      const found = registry.lookup(name);
      if (!found.ok) throw new Error(`${name} is not registered`);
      expect(`${name}: ${pluginAccessOf(found.value)}`).toBe(`${name}: write`);
    }
  });
});
