// SPDX-License-Identifier: MPL-2.0

/**
 * #1144 — one plugin's `onActivate` runs once at a time across processes.
 *
 * Every admin instance and every build subprocess that loads a plugin runs
 * its `onActivate` seed. Two at once each found an empty table and both
 * seeded, so the consent-manager's default categories existed twice and the
 * duplicate-id check of list sources (#1121) failed the static build. A
 * transaction-scoped advisory lock keyed by the plugin slug serializes the
 * hook: the transaction only holds the lock, the plugin's own writes commit
 * in their own transactions inside it, so a second activation waiting on
 * the lock sees them once the first has finished.
 */

import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import type { PluginHostInfra } from "./dispatch.js";

/**
 * Run `fn` while holding the activation lock of plugin `slug`.
 *
 * @param systemActorId - the host's system actor; the lock transaction runs as it.
 */
export async function runActivationSerialized<T>(
  infra: Pick<PluginHostInfra, "adapter">,
  systemActorId: string,
  slug: string,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx: ExecutionContext = {
    actorId: systemActorId,
    actorKind: "system",
    requestId: `plugin-activate-${slug}`,
  };
  // The holder name puts this transaction on the nested-checkout allowlist
  // (query-api pool-guard.ts): `fn`'s writes open their own transactions
  // while this one holds the lock.
  return infra.adapter.withAdminTransaction(
    ctx,
    async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`caelo:plugin-activate:${slug}`}, 0))`,
      );
      return fn();
    },
    { holder: "plugins.activation_lock" },
  );
}
