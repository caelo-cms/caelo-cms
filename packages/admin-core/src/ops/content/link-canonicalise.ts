// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout D) — `links.canonicalise_values`: core's write-time
 * link canonicalisation, offered to plugins that store module content in
 * their own tables.
 *
 * Core's own content writes canonicalise internal links at the Validator
 * boundary (rollout C): `/about` is stored as `caelo:page/<id>`, a path
 * that names no page is refused. international-site keeps a language's
 * own chrome content (`set_chrome_variants`) in its plugin table, which
 * core's write ops never see. Before rollout D the plugin remapped the
 * literal paths in there at render time; the link-resolve composition
 * point resolves page REFERENCES only, so the plugin now hands its
 * values to this op before storing them — same rules, same lookup, same
 * AI-actionable refusal as a core write.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { canonicaliseContentValues, err, ok } from "@caelo-cms/shared";
import { z } from "zod";
import { canonicaliseLinksForWrite } from "../../links/canonicalise.js";

export const canonicaliseLinkValuesOp = defineOperation({
  name: "links.canonicalise_values",
  // Why system-only: (plugin + system) a write-path building block, not an
  // editing action. Plugins call it from their own write operations (the
  // AI reaches it through those tools, e.g. set_chrome_variants, which
  // own the write and its snapshot); core's write ops canonicalise
  // in-process. A direct AI tool would transform values without storing
  // them anywhere.
  actorScope: ["plugin", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** The module's fields (a `url` / `link` field's whole value is a link). */
      fields: z.array(z.object({ name: z.string(), kind: z.string() })).max(500),
      values: z.record(z.string(), z.unknown()),
      /** The stored values this write replaces: their link literals are
       *  grandfathered, as for a core update. */
      previous: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  output: z.object({ values: z.record(z.string(), z.unknown()) }),
  handler: async (ctx, input, tx) => {
    const r = await canonicaliseLinksForWrite(
      tx,
      ctx,
      input.values,
      (run) => canonicaliseContentValues(input.fields, input.values, run),
      input.previous === undefined ? {} : { previous: input.previous },
    );
    if (!r.ok) {
      return err({
        kind: "HandlerError",
        operation: "links.canonicalise_values",
        message: r.message,
      });
    }
    return ok({ values: r.value });
  },
});
