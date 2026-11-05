// SPDX-License-Identifier: MPL-2.0

/**
 * #1323 — `lists.plugin_source_texts`: the values of plugin list sources
 * that are offered to one plugin, as the source plugin stored them.
 *
 * A translating plugin must see a source's text to offer it for
 * translation and to notice when it changed, and it may not read another
 * plugin's storage. A source marks those fields with the asker's own
 * attribute (`ext.<pluginSlug>`, `plugin-host/src/list-source-overlays.ts`);
 * this op hands out exactly those values, which every visitor reads anyway.
 * They run through the plugin's own source operation, so a chat sees its
 * branch's text.
 */

import { markedSourceEntries, sourceEntriesOf, sourcesMarkedFor } from "@caelo-cms/plugin-host";
import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { z } from "zod";
import { branchOf } from "./_shared.js";

const OP = "lists.plugin_source_texts";

export const pluginSourceTextsOp = defineOperation({
  name: OP,
  readScope: "request",
  // Why plugin: this is the read a translating plugin has of another
  // plugin's visitor-facing texts; it holds no other way to them.
  actorScope: ["human", "ai", "plugin", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** The plugin whose attribute marks the fields. */
      pluginSlug: z.string().min(1).max(64),
      /**
       * Any page of the site: a source with marked fields has the same
       * entries on every page, and its operation answers per page.
       */
      pageId: z.string().uuid(),
    })
    .strict(),
  output: z.object({
    sources: z.array(
      z.object({
        name: z.string(),
        label: z.string(),
        fields: z.array(z.record(z.string(), z.unknown())),
        entries: z.array(z.object({ id: z.string(), values: z.record(z.string(), z.unknown()) })),
      }),
    ),
    /** Plugins whose source failed: their texts are not in `sources`, nothing said they are gone. */
    failed: z.array(z.string()),
  }),
  handler: async (ctx, input) => {
    const marked = sourcesMarkedFor(input.pluginSlug);
    if (marked.length === 0) return ok({ sources: [], failed: [] });
    const failed = new Set<string>();
    const resolved = await sourceEntriesOf(
      [input.pageId],
      {
        chatBranchId: branchOf(ctx),
        // One broken plugin must not stop another's translation tools.
        onPluginFailure: (f) => failed.add(f.slug),
      },
      // Why fixed: the style only shapes page links, and a marked field is
      // text; this read must not depend on a deploy target existing.
      "directory",
    );
    return ok({
      sources: markedSourceEntries(marked, resolved.get(input.pageId) ?? {}),
      failed: [...failed],
    });
  },
});
