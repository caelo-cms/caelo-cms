// SPDX-License-Identifier: MPL-2.0

import type { ExecutionContext, Result } from "@caelo/shared";
import { err } from "@caelo/shared";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";
import { isRlsDenial, type QueryError } from "./errors.js";
import type { OperationDefinition } from "./operation.js";

/**
 * Two connection pools per process — one per PostgreSQL role. Application code
 * never mixes roles in a single query. The admin pool targets `cms_admin` (the
 * authoring database, connected as `admin_role`); the public pool targets
 * `cms_public` and is expected to connect as either `public_role` (API
 * Gateway runtime path) or `admin_role` (admin-side reads of plugin data for
 * moderation + migrations).
 *
 * The adapter verifies role + database identity on first use via
 * `current_user` / `current_database()` — misconfiguration (e.g. a typo that
 * swaps the two URLs) fails loudly rather than allowing the RLS model to
 * silently misbehave.
 */
export interface AdapterConfig {
  readonly adminDatabaseUrl: string;
  readonly publicDatabaseUrl: string;
  /** Disable the startup self-check. Only for tests that deliberately assert it triggers. */
  readonly skipRoleVerification?: boolean;
}

interface ConnectionIdentity {
  readonly user: string;
  readonly database: string;
}

export class DatabaseAdapter {
  readonly #admin: BunSQLDatabase;
  readonly #public: BunSQLDatabase;
  readonly #adminRaw: SQL;
  readonly #publicRaw: SQL;
  readonly #skipVerify: boolean;
  #verifyPromise: Promise<void> | null = null;

  constructor(config: AdapterConfig) {
    this.#adminRaw = new SQL(config.adminDatabaseUrl);
    this.#publicRaw = new SQL(config.publicDatabaseUrl);
    this.#admin = drizzle(this.#adminRaw);
    this.#public = drizzle(this.#publicRaw);
    this.#skipVerify = config.skipRoleVerification === true;
  }

  /**
   * One-shot startup self-check. Asserts that:
   *   - the admin pool connects as `admin_role` to `cms_admin`
   *   - the public pool connects to `cms_public` as `admin_role` or `public_role`
   *
   * Memoised — runs once and remembers. Exposed as a public method so callers
   * can fail-fast on startup instead of at first op. Also runs automatically
   * before the first `runOperation()` unless `skipRoleVerification` is set.
   */
  verifyRoles(): Promise<void> {
    // Not `async` on purpose — we return the cached Promise *reference* so a
    // second call === the first; `async` would wrap it in a fresh Promise and
    // break that identity.
    if (this.#verifyPromise !== null) return this.#verifyPromise;
    this.#verifyPromise = this.#verifyRolesOnce();
    return this.#verifyPromise;
  }

  async #verifyRolesOnce(): Promise<void> {
    const admin = await this.#identity(this.#adminRaw);
    if (admin.user !== "admin_role" || admin.database !== "cms_admin") {
      throw new Error(
        `DatabaseAdapter admin pool expected (admin_role, cms_admin) but connected as (${admin.user}, ${admin.database}). Check ADMIN_DATABASE_URL.`,
      );
    }
    const pub = await this.#identity(this.#publicRaw);
    if (pub.database !== "cms_public") {
      throw new Error(
        `DatabaseAdapter public pool expected database cms_public but connected to ${pub.database}. Check PUBLIC_DATABASE_URL / PUBLIC_ADMIN_DATABASE_URL.`,
      );
    }
    if (pub.user !== "admin_role" && pub.user !== "public_role") {
      throw new Error(
        `DatabaseAdapter public pool expected user admin_role or public_role, got ${pub.user}.`,
      );
    }
  }

  async #identity(pool: SQL): Promise<ConnectionIdentity> {
    const rows =
      (await pool`SELECT current_user::text AS user, current_database()::text AS database`) as unknown as ConnectionIdentity[];
    const row = rows[0];
    if (!row) throw new Error("connection identity probe returned no row");
    return row;
  }

  /**
   * Execute an operation inside a transaction scoped to the caller's identity.
   * Session vars are set via `set_config(name, value, true)` (parameterised) so
   * there is no string interpolation at the SQL boundary.
   */
  async runOperation<I, O>(
    op: OperationDefinition<I, O>,
    ctx: ExecutionContext,
    validatedInput: I,
  ): Promise<Result<O, QueryError>> {
    if (!this.#skipVerify) await this.verifyRoles();

    const db = op.database === "cms_admin" ? this.#admin : this.#public;

    try {
      return await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('caelo.actor_id', ${ctx.actorId}, true)`);
        await tx.execute(sql`SELECT set_config('caelo.actor_kind', ${ctx.actorKind}, true)`);
        await tx.execute(sql`SELECT set_config('caelo.plugin_id', ${ctx.pluginId ?? ""}, true)`);

        return await op.handler(ctx, validatedInput, tx);
      });
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

  get admin(): BunSQLDatabase {
    return this.#admin;
  }
  get public(): BunSQLDatabase {
    return this.#public;
  }
}
