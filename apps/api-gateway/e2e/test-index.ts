// SPDX-License-Identifier: MPL-2.0

/**
 * Publish a test site's collection index the way a Stage and Publish live do,
 * so the admin's projection publishes it, and keeps publishing it.
 *
 * The visitor-site fixtures (search, assistant, visitor AI) used to write the
 * index pointer straight into `cms_public.published_collections`. The
 * projection replaces that table whenever it republishes the plugins section,
 * and the fixtures' own plugin writes mark that section in the outbox, which
 * the e2e admin's scheduler tick drains: the pointer vanished at a moment no
 * test chose, and the gateway answered `IndexNotReady` (CI run 45574389977,
 * the first failure in 46 runs). As admin state, a ready `collection_releases`
 * row of the run the release pointers name, the pointer is part of what every
 * later publish derives.
 *
 * Call it after `releaseProjectionForTests`, and again after each later one:
 * every release freezes a new run. It then publishes every section once more,
 * as the admin's tick does, and refuses to go on if the pointer did not
 * survive: the race is forced at every start instead of left to timing.
 */

import { drainProjectionOnce, publishProjectionOnce } from "@caelo-cms/admin-core";
import type { DatabaseAdapter } from "@caelo-cms/query-api";
import { SQL } from "bun";

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";

/** One collection release of a test site. */
export interface TestIndex {
  readonly pluginId: string;
  readonly collection: string;
  readonly releaseKey: string;
}

async function asSystem<T>(url: string, fn: (tx: SQL) => Promise<T>): Promise<T> {
  const conn = new SQL(url);
  try {
    return (await conn.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await conn.end();
  }
}

/**
 * Make `index` the ready release of its collection on the run each release
 * pointer names, then publish. The frozen test run has no deploy run of its
 * own, so it gets a finished staging one with the same id (the release rows
 * belong to a deploy run). Needs the plugin host still loaded (the full
 * publish reads its visitor projections).
 */
export async function publishTestIndex(
  urls: { readonly admin: string; readonly publicAdmin: string },
  admin: DatabaseAdapter,
  staging: DatabaseAdapter,
  index: TestIndex,
): Promise<void> {
  const adminUrl = urls.admin;
  await asSystem(adminUrl, async (tx) => {
    const pointed =
      (await tx`SELECT DISTINCT run_id::text AS run FROM projection_release_pointers`) as {
        run: string;
      }[];
    if (pointed.length === 0)
      throw new Error("no release pointer yet: call releaseProjectionForTests first");
    for (const { run } of pointed) {
      await tx`INSERT INTO deploy_runs (id, target_id, actor_id, status, finished_at)
               SELECT ${run}::uuid, id, ${SYSTEM_ACTOR_ID}::uuid, 'succeeded', now()
                 FROM deploy_targets WHERE name = 'staging'
               ON CONFLICT (id) DO NOTHING`;
      await tx`INSERT INTO collection_releases (run_id, plugin_id, collection, state, release_key, finished_at)
               VALUES (${run}::uuid, ${index.pluginId}::uuid, ${index.collection}, 'ready', ${index.releaseKey}, now())
               ON CONFLICT (run_id, plugin_id, collection)
               DO UPDATE SET state = 'ready', release_key = EXCLUDED.release_key, finished_at = now()`;
    }
  });
  await drainProjectionOnce(admin, staging);
  // What the admin's tick does next: publish every section from its state.
  await publishProjectionOnce(admin, staging, { comments: false });
  const published = await asSystem(
    urls.publicAdmin,
    async (tx) =>
      (await tx`SELECT release_key FROM published_collections
                WHERE plugin_id = ${index.pluginId}::uuid AND collection = ${index.collection}`) as {
        release_key: string;
      }[],
  );
  if (published[0]?.release_key !== index.releaseKey)
    throw new Error(
      `the ${index.collection} index of ${index.pluginId} did not survive a full publish (published: ${JSON.stringify(published)})`,
    );
}

/**
 * Remove the test indexes of these plugins from the admin state, so the next
 * publish drops their pointers (the admin's tick, or the caller's drain).
 * The finished staging runs `publishTestIndex` added stay: a test run's
 * frozen state outlives it the same way.
 */
export async function removeTestIndexes(adminUrl: string, slugs: readonly string[]): Promise<void> {
  await asSystem(adminUrl, async (tx) => {
    for (const slug of slugs)
      await tx`DELETE FROM collection_releases
               WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${slug})`;
  });
}
