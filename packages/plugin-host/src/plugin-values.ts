// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — values a plugin hands a page (docs/dev/external-plugin-brokers.md
 * §4.5). The checks are pure and live in shared (`lists/plugin-values.ts`),
 * so the list resolver applies them where an overlay value meets its field;
 * they are re-exported here for the plugin host's composition points. What
 * the host adds is the media table's facts ({@link describePluginMedia}),
 * which `checkPluginMedia` decides on.
 */

import { execute, joinHeldTransaction } from "@caelo-cms/query-api";
import type { PluginMediaFacts } from "@caelo-cms/shared";
import { hostInfra, hostSystemActorId } from "./dispatch.js";

export {
  checkPluginMedia,
  checkPluginValue,
  escapePluginText,
  type PluginMediaFacts,
  pluginMediaId,
  richtextProblem,
  urlProblem,
} from "@caelo-cms/shared";

/**
 * What the media table says of the ids one answer names, 1000 per read
 * (`media.describe_many`, O(ids)). Media is not branched, so a preview and
 * a build see the same facts.
 */
export async function describePluginMedia(
  ids: ReadonlyArray<string>,
): Promise<Map<string, PluginMediaFacts>> {
  const out = new Map<string, PluginMediaFacts>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;
  const infra = hostInfra();
  for (let i = 0; i < unique.length; i += 1000) {
    // #1254 — render-time read work: it joins a transaction the caller holds
    // (an in-process build holds one) instead of taking a second connection.
    const r = await joinHeldTransaction(() =>
      execute(
        infra.registry,
        infra.adapter,
        { actorId: hostSystemActorId(), actorKind: "system", requestId: "plugin-values-media" },
        "media.describe_many",
        { ids: unique.slice(i, i + 1000) },
      ),
    );
    if (!r.ok) {
      throw new Error(
        `plugin values: the media check failed: ${"message" in r.error ? (r.error as { message: string }).message : r.error.kind}`,
      );
    }
    for (const a of (r.value as { assets: Array<{ id: string } & PluginMediaFacts> }).assets) {
      out.set(a.id, { visibility: a.visibility, mime: a.mime });
    }
  }
  return out;
}
