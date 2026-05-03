// SPDX-License-Identifier: MPL-2.0

/**
 * Reusable RLS adversarial matrix for a per-plugin table in `cms_public`.
 *
 * In P1 we run it against the dummy `rls_sentinel` table; in P11 every plugin
 * activation runs this same matrix against its newly-registered tables so the
 * adversarial gate scales with the plugin surface automatically.
 *
 * The matrix encodes two guarantees that must hold for any per-plugin table:
 *   (A) plugin A cannot INSERT a row claiming plugin_id='B' (WITH CHECK rejects)
 *   (B) plugin A cannot SELECT plugin B's existing rows (USING filters to zero)
 *
 * Callers supply a table name + the plugin id column + a way to INSERT and
 * count rows. The helper handles the rest.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  type DatabaseAdapter,
  defineOperation,
  execute,
  type OperationDefinition,
  OperationRegistry,
} from "../index.js";

export interface RlsMatrixConfig {
  /** Fully-qualified table name in cms_public (e.g. `rls_sentinel`). */
  readonly table: string;
  /** Column on that table that stores the plugin_id. */
  readonly pluginIdColumn: string;
  /** Minimal INSERT that includes at least `pluginIdColumn`; additional cols should be supplied as a VALUES clause. */
  readonly insertSqlTemplate: (pluginIdBind: string) => string;
  /** Must return a DB factory + two plugin identities used for the test. */
  readonly identities: { pluginA: ExecutionContext; pluginB: ExecutionContext };
  /** Test group label. */
  readonly label: string;
  /** Adapter factory (typically a closure over ADMIN_URL + PUBLIC_URL from the calling test). */
  readonly adapterFactory: () => DatabaseAdapter;
}

export function rlsAdversarialMatrix(cfg: RlsMatrixConfig): void {
  describe(cfg.label, () => {
    let adapter: DatabaseAdapter;
    let registry: OperationRegistry;

    const insertOp: OperationDefinition<
      { claimedPluginId: string; payload: string },
      Record<string, never>
    > = defineOperation({
      name: `rls_matrix.${cfg.table}.insert`,
      actorScope: ["plugin", "system"],
      database: "cms_public",
      input: z.object({ claimedPluginId: z.string(), payload: z.string() }),
      output: z.object({}),
      handler: async (_ctx, input, tx) => {
        await tx.execute(sql.raw(cfg.insertSqlTemplate(`'${input.claimedPluginId}'`)));
        void input;
        return ok({});
      },
    });

    const countOp = defineOperation({
      name: `rls_matrix.${cfg.table}.count`,
      actorScope: ["plugin", "system"],
      database: "cms_public",
      input: z.object({}),
      output: z.object({ count: z.number() }),
      handler: async (_ctx, _input, tx) => {
        const rows = (await tx.execute(
          sql.raw(`SELECT count(*)::int AS c FROM ${cfg.table}`),
        )) as unknown as { c: number }[];
        return ok({ count: rows[0]?.c ?? 0 });
      },
    });

    beforeAll(async () => {
      adapter = cfg.adapterFactory();
      registry = new OperationRegistry();
      registry.register(insertOp);
      registry.register(countOp);
    });

    it(`(A) INSERT claiming another plugin's id fails — WITH CHECK denies`, async () => {
      const attempt = await execute(registry, adapter, cfg.identities.pluginA, insertOp.name, {
        claimedPluginId: cfg.identities.pluginB.pluginId ?? "__missing__",
        payload: "spoof",
      });
      expect(attempt.ok).toBe(false);
      if (!attempt.ok) expect(attempt.error.kind).toBe("RLSDenied");
    });

    it(`(B) SELECT from another plugin's rows returns zero — USING filters`, async () => {
      const seed = await execute(registry, adapter, cfg.identities.pluginB, insertOp.name, {
        claimedPluginId: cfg.identities.pluginB.pluginId ?? "__missing__",
        payload: "B's own row",
      });
      expect(seed.ok).toBe(true);

      const aSees = await execute(registry, adapter, cfg.identities.pluginA, countOp.name, {});
      expect(aSees.ok).toBe(true);
      if (aSees.ok) expect((aSees.value as { count: number }).count).toBe(0);
    });
  });
}
