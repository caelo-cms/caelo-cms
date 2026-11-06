// SPDX-License-Identifier: MPL-2.0

/**
 * #1484 — a build refused over the site's content is a `BuildRefusal`, so the
 * CLI reports a refusal and the chat files no bug (#1462). The admin side of
 * the event is pinned in admin-core's tool-failure-capture integration test.
 */

import { describe, expect, it } from "bun:test";
import type { TransactionRunner } from "@caelo-cms/query-api";
import { BuildRefusal } from "./build-refusal.js";
import { type BuildPluginServices, resolveBuildContentVariants } from "./content-variants-pass.js";

describe("#1484 BuildRefusal", () => {
  it("a page with no content in its language is refused, not crashed (#1462)", async () => {
    const plugins = {
      hasContentVariantContributors: async () => true,
      resolveContentVariants: async () =>
        new Map([
          [
            "p1",
            new Map([
              [
                "page:content:2",
                {
                  pluginSlug: "international-site",
                  problems: ['there is no English (en) version of "Demo" (shared content) yet.'],
                },
              ],
            ]),
          ],
        ]),
    } as unknown as BuildPluginServices;
    const pages = [
      { pageId: "p1", slug: "news", layoutId: "l1", layoutBlocks: new Map(), pageBlocks: [] },
    ];
    const built = resolveBuildContentVariants({} as TransactionRunner, plugins, pages as never);
    await expect(built).rejects.toBeInstanceOf(BuildRefusal);
    await expect(built).rejects.toThrow("have no content to ship");
  });
});
