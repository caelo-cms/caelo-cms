// SPDX-License-Identifier: MPL-2.0

import type { ExecutionContext, Result } from "@caelo/shared";
import { err } from "@caelo/shared";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";
import type { QueryError } from "./errors.js";
import { isRlsDenial } from "./errors.js";
import type { OperationDefinition, TransactionRunner } from "./operation.js";

/**
 * Two connection pools per process — one per PostgreSQL role. Application code
 * never mixes roles in a single query. The admin pool sees `cms_admin` only,
 * the public pool sees `cms_public` only. Declared at adapter-construction time;
 * never swapped at runtime (swapping a role mid-flight would break RLS intent).
 */
export interface AdapterConfig {
  readonly adminDatabaseUrl: string;
  readonly publicDatabaseUrl: string;
}

export class DatabaseAdapter {
  readonly #admin: BunSQLDatabase;
  readonly #public: BunSQLDatabase;
  readonly #adminRaw: SQL;
  readonly #publicRaw: SQL;

  constructor(config: AdapterConfig) {
    this.#adminRaw = new SQL(config.adminDatabaseUrl);
    this.#publicRaw = new SQL(config.publicDatabaseUrl);
    this.#admin = drizzle(this.#adminRaw);
    this.#public = drizzle(this.#publicRaw);
  }

  /**
   * Execute an operation inside a transaction scoped to the caller's identity.
   * The `SET LOCAL` session vars make the RLS policies observable via
   * `current_setting('caelo.actor_id', true)` etc. Rollback on handler failure
   * undoes both the data writes and the session settings.
   */
  async runOperation<I, O>(
    op: OperationDefinition<I, O>,
    ctx: ExecutionContext,
    validatedInput: I,
  ): Promise<Result<O, QueryError>> {
    const db = op.database === "cms_admin" ? this.#admin : this.#public;

    try {
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL caelo.actor_id = '${sanitize(ctx.actorId)}'`));
        await tx.execute(sql.raw(`SET LOCAL caelo.actor_kind = '${sanitize(ctx.actorKind)}'`));
        const pluginSetting = ctx.pluginId ? sanitize(ctx.pluginId) : "";
        await tx.execute(sql.raw(`SET LOCAL caelo.plugin_id = '${pluginSetting}'`));

        const runner = tx as unknown as TransactionRunner;
        return await op.handler(ctx, validatedInput, runner);
      });
      return result;
    } catch (thrown) {
      if (isRlsDenial(thrown)) {
        return err({
          kind: "RLSDenied",
          operation: op.name,
          detail: (thrown as { message?: string }).message ?? "RLS policy denied the write",
        });
      }
      return err({
        kind: "HandlerError",
        operation: op.name,
        message: thrown instanceof Error ? thrown.message : String(thrown),
      });
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.#adminRaw.end(), this.#publicRaw.end()]);
  }

  /** Test-only: raw access for fixture setup / adversarial direct queries. */
  rawAdmin(): SQL {
    return this.#adminRaw;
  }
  rawPublic(): SQL {
    return this.#publicRaw;
  }

  // Narrow re-exports for handlers that want typed drizzle query builders.
  get admin(): BunSQLDatabase {
    return this.#admin;
  }
  get public(): BunSQLDatabase {
    return this.#public;
  }
}

/**
 * Defence-in-depth: we only accept session-var values that are safe characters.
 * The inputs come from our own `ExecutionContext` so they should already be
 * UUIDs / enum strings / plugin ids, but cheap guard for a critical invariant.
 */
function sanitize(value: string): string {
  if (!/^[A-Za-z0-9_\-.:@]*$/.test(value)) {
    throw new Error(
      `refusing to SET LOCAL with unsafe characters in value: ${JSON.stringify(value)}`,
    );
  }
  return value;
}
