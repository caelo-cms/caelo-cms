// SPDX-License-Identifier: MPL-2.0

/**
 * Test utilities for seeding actors into cms_admin under RLS.
 *
 * The adversarial tests in this directory deliberately exercise the RLS
 * `WITH CHECK` clause, so even seed fixtures must either (a) run under a
 * `system`-kind session or (b) match their own actor id. This helper takes
 * the first path: one transaction per seed with `SET LOCAL caelo.actor_kind`
 * set to `system`.
 */

import type { SQL } from "bun";

export interface ActorSeed {
  readonly id: string;
  readonly kind: "human" | "ai" | "plugin" | "system";
  readonly displayName: string;
}

export async function seedActors(admin: SQL, actors: readonly ActorSeed[]): Promise<void> {
  await admin.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    for (const actor of actors) {
      await tx`
        INSERT INTO actors (id, kind, display_name)
        VALUES (${actor.id}::uuid, ${actor.kind}, ${actor.displayName})
        ON CONFLICT (id) DO NOTHING
      `;
    }
  });
}

export async function deleteActors(admin: SQL, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await admin.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    for (const id of ids) {
      await tx`DELETE FROM audit_events WHERE actor_id = ${id}::uuid`;
      await tx`DELETE FROM actors WHERE id = ${id}::uuid`;
    }
  });
}
