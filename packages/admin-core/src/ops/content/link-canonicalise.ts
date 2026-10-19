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

/** Field / value-key cap: generous for any real module, bounded for the walk. */
const MAX_KEYS = 500;

const boundedValues = z
  .record(z.string(), z.unknown())
  .refine((v) => Object.keys(v).length <= MAX_KEYS, {
    message: `at most ${MAX_KEYS} top-level keys — split the write`,
  });

/**
 * `links.canonicalise_values` — canonicalise one module's content
 * values the way a core content write does, and return them; stores
 * nothing. A path that names no page is refused with core's next step.
 *
 * @example
 *   await ctx.cms.call("links.canonicalise_values", {
 *     fields: [{ name: "cta_href", kind: "url" }],
 *     values: { cta_href: "/pricing" },
 *   }); // → { values: { cta_href: "caelo:page/<id>" } }
 */
export const canonicaliseLinkValuesOp = defineOperation({
  name: "links.canonicalise_values",
  // Why plugin + system only (no human, no ai): a write-path building
  // block, not an editing action. Plugins call it from their own write
  // operations (the AI reaches it through those tools, e.g.
  // set_chrome_variants, which own the write and its snapshot); core's
  // write ops canonicalise in-process. A direct AI or human call would
  // transform values without storing them anywhere.
  actorScope: ["plugin", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** The module's fields (a `url` / `link` field's whole value is a link). */
      fields: z.array(z.object({ name: z.string(), kind: z.string() })).max(MAX_KEYS),
      values: boundedValues,
      /**
       * The stored values this write replaces: their link literals are
       * grandfathered, as for a core update. Caller-supplied, so a plugin
       * can only exempt literals from refusal for values it then stores
       * in its OWN tables — this op writes nothing, and core's own write
       * ops take `previous` from the database, never from this input.
       */
      previous: boundedValues.optional(),
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
