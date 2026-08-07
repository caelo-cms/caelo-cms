// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/capabilities — per-plugin context factory.
 *
 * Builds a fresh `PluginContext` (Tier 2) or `PluginContextTier1` for each
 * operation invocation. The handles are CLOSURES over the host infra + the
 * plugin's identity; they pass the plugin's actor id + plugin id into the
 * adapter's session vars so RLS scopes correctly.
 *
 * Capability gating: `ctx.cms` / `ctx.ai` / `ctx.snapshots` are only attached
 * if the plugin's manifest declares the matching `requestedCapabilities`.
 * Runtime-authored plugins NEVER get these — provenance is the grantability
 * ceiling (#388); the function returns the locked base `PluginContext` for
 * them regardless of the manifest.
 */

import type {
  PluginAdminQuery,
  PluginAi,
  PluginCapability,
  PluginCaptcha,
  PluginCms,
  PluginContext,
  PluginContextTier1,
  PluginDomainEvent,
  PluginEmail,
  PluginEvents,
  PluginQuery,
  PluginQueryFilter,
  PluginSnapshots,
  PluginTheme,
  PluginVisitor,
} from "@caelo-cms/plugin-sdk";
import { execute } from "@caelo-cms/query-api";
import { recordCapLookupFailure, recordCapLookupSuccess } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import type { LoadedPlugin, PluginHostInfra } from "./dispatch.js";

export interface MakePluginContextOpts {
  readonly plugin: LoadedPlugin;
  readonly infra: PluginHostInfra;
  readonly visitorContext?: VisitorContext;
}

/**
 * Per-request visitor context, populated by the gateway from cookies.
 * `sessionMutation` is mutated by the auth plugin's setSession; the
 * gateway reads it after dispatch to emit the right Set-Cookie header.
 */
export interface VisitorContext {
  readonly visitorId: string;
  readonly sessionToken: string | null;
  readonly sessionMutation?: { current: SessionMutation };
}

export type SessionMutation =
  | { kind: "none" }
  | { kind: "set"; sessionToken: string; expiresAt: string }
  | { kind: "clear" };

/**
 * Build the per-call context. Returns the locked base PluginContext for
 * runtime-authored plugins and an extended PluginContextTier1 for
 * release-signed plugins (with only the requested capability handles
 * attached) — provenance is the ceiling, the capability set the grant.
 */
export async function makePluginContext(
  opts: MakePluginContextOpts,
): Promise<PluginContext | PluginContextTier1> {
  const { plugin, infra, visitorContext } = opts;
  const requested = new Set<PluginCapability>(plugin.definition.requestedCapabilities ?? []);

  const baseCtx: PluginContext = {
    query: makePluginQuery(plugin, infra),
    api: makePluginApi(plugin, infra),
    theme: makePluginTheme(),
    visitor: makePluginVisitor(visitorContext),
    captcha: makePluginCaptcha(),
  };

  // #388 grantability ceiling — provenance, not tier, decides what a
  // plugin can be GIVEN: runtime-authored plugins get the sandbox base
  // and nothing else, regardless of what their manifest requests (the
  // validator rejects such manifests anyway; this is the runtime's
  // independent enforcement of the same ceiling).
  if (plugin.provenance === "runtime-authored") return baseCtx;

  // Release-signed — attach elevated handles per requestedCapabilities.
  const tier1: Mutable<PluginContextTier1> = { ...baseCtx };
  if (requested.has("cms_admin")) {
    tier1.cms = makePluginCms(plugin, infra);
  }
  if (requested.has("cms_admin_schema")) {
    tier1.adminQuery = makePluginAdminQuery(plugin, infra);
  }
  if (requested.has("domain_events")) {
    tier1.events = makePluginEvents(plugin, infra);
  }
  if (requested.has("ai_provider") && infra.aiProvider) {
    tier1.ai = makePluginAi(plugin, infra);
  }
  if (requested.has("snapshots")) {
    tier1.snapshots = makePluginSnapshots(plugin, infra);
  }
  if (requested.has("email")) {
    tier1.email = makePluginEmail(infra);
  }
  return tier1;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// ---------------------------------------------------------------------------
// PluginQuery (P12 PR1.1) — real cms_public dispatch.
//
// Routes against the public Postgres pool. Each call opens its own tx,
// sets `caelo.plugin_id` + `caelo.actor_kind = 'plugin'` so the per-plugin
// RLS policy emitted by plugin-sandbox/schema.ts gates every row read +
// write. Identifiers (table + column names) are validated against the
// plugin's manifest.schema before being interpolated; values flow through
// parameterised SQL — no raw SQL crosses the boundary.
// ---------------------------------------------------------------------------

const SAFE_IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function pluginSchemaName(slug: string): string {
  return `plugin_${slug.replace(/-/g, "_")}`;
}

function declaredColumnsIn(
  schemaMap: Readonly<Record<string, Readonly<Record<string, string>>>>,
  table: string,
): Set<string> | null {
  const tableSpec = schemaMap[table];
  if (!tableSpec) return null;
  return new Set(Object.keys(tableSpec));
}

function validateIdent(name: string, label: string): void {
  if (!SAFE_IDENT_RE.test(name)) {
    throw new Error(
      `ctx.query: refusing to interpolate ${label} "${name}" (must match ${SAFE_IDENT_RE})`,
    );
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`ctx.query: refusing to set session var ${label}: not a UUID (${value})`);
  }
}

interface QueryScope {
  /** Error-message prefix — "ctx.query" | "ctx.adminQuery". */
  readonly label: string;
  /** Which manifest map declares the reachable tables. */
  readonly schemaLabel: "schema" | "adminSchema";
  readonly schemaMap: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly pool: "public" | "admin";
}

function makeScopedQuery(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  scope: QueryScope,
): PluginQuery {
  const schemaName = pluginSchemaName(plugin.slug);
  validateIdent(schemaName, "schema");
  // P12 review-pass #1 — UUIDs are validated at construction time so we
  // fail fast (and loudly) the moment an attacker-controlled value
  // somehow lands in `pluginActorId` / `pluginId`. Even with the
  // parameterised set_config below this is the second layer of defence.
  assertUuid(plugin.pluginActorId, "caelo.actor_id");
  assertUuid(plugin.pluginId, "caelo.plugin_id");

  async function withPluginTx<T>(
    fn: (tx: Parameters<Parameters<typeof infra.adapter.public.transaction>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    const pool = scope.pool === "admin" ? infra.adapter.admin : infra.adapter.public;
    return pool.transaction(async (tx) => {
      // P12 review-pass #1 — set_config takes parameterised values; the
      // SETTING NAME is a literal (Postgres doesn't parameterise it).
      // Guards above make sure the *values* are UUIDs, and `set_config`'s
      // third arg `true` scopes the setting to the current transaction.
      await tx.execute(sql`SELECT set_config('caelo.actor_kind', 'plugin', true)`);
      await tx.execute(sql`SELECT set_config('caelo.actor_id', ${plugin.pluginActorId}, true)`);
      await tx.execute(sql`SELECT set_config('caelo.plugin_id', ${plugin.pluginId}, true)`);
      return fn(tx);
    });
  }

  return {
    insert: async (table, data) => {
      const tableStr = table as string;
      validateIdent(tableStr, "table");
      const declared = declaredColumnsIn(scope.schemaMap, tableStr);
      if (!declared) {
        throw new Error(
          `${scope.label}.insert: table "${tableStr}" not declared in plugin "${plugin.slug}".${scope.schemaLabel}`,
        );
      }
      const cols: string[] = [];
      const valueFragments: ReturnType<typeof sql>[] = [];
      for (const [k, v] of Object.entries(data)) {
        if (!declared.has(k)) {
          throw new Error(
            `${scope.label}.insert: column "${k}" not declared in plugin "${plugin.slug}".${scope.schemaLabel}.${tableStr}`,
          );
        }
        validateIdent(k, "column");
        cols.push(`"${k}"`);
        valueFragments.push(sql`${v}`);
      }
      if (cols.length === 0) {
        throw new Error(`${scope.label}.insert: data must include at least one declared column`);
      }
      const colsSql = sql.raw(cols.join(", "));
      const valuesSql = sql.join(valueFragments, sql`, `);
      const fqTable = sql.raw(`"${schemaName}"."${tableStr}"`);
      return withPluginTx(async (tx) => {
        const rows = (await tx.execute(
          sql`INSERT INTO ${fqTable} (${colsSql}) VALUES (${valuesSql}) RETURNING id::text AS id`,
        )) as unknown as { id: string }[];
        const id = rows[0]?.id;
        if (!id) throw new Error(`${scope.label}.insert: no id returned`);
        return { id };
      });
    },

    list: async <T = Record<string, unknown>>(
      table: string,
      filter?: PluginQueryFilter,
    ): Promise<T[]> => {
      validateIdent(table, "table");
      const declared = declaredColumnsIn(scope.schemaMap, table);
      if (!declared) {
        throw new Error(
          `${scope.label}.list: table "${table}" not declared in plugin "${plugin.slug}".${scope.schemaLabel}`,
        );
      }
      const wheres: ReturnType<typeof sql>[] = [];
      let limit = 100;
      let orderBy: string | null = null;
      let orderDir: "asc" | "desc" = "desc";
      let since: string | null = null;
      for (const [k, v] of Object.entries(filter ?? {})) {
        if (k === "limit") {
          if (typeof v !== "number" || v <= 0 || v > 1000) {
            throw new Error(`${scope.label}.list: limit must be 1..1000`);
          }
          limit = v;
          continue;
        }
        if (k === "orderBy") {
          if (typeof v !== "string") throw new Error(`${scope.label}.list: orderBy must be string`);
          if (!declared.has(v)) {
            throw new Error(`${scope.label}.list: orderBy "${v}" not declared in schema`);
          }
          validateIdent(v, "column");
          orderBy = v;
          continue;
        }
        if (k === "orderDir") {
          if (v !== "asc" && v !== "desc")
            throw new Error(`${scope.label}.list: orderDir must be asc|desc`);
          orderDir = v;
          continue;
        }
        if (k === "since") {
          if (typeof v !== "string")
            throw new Error(`${scope.label}.list: since must be ISO timestamp string`);
          since = v;
          continue;
        }
        if (!declared.has(k)) {
          throw new Error(
            `${scope.label}.list: column "${k}" not declared in plugin "${plugin.slug}".${scope.schemaLabel}.${table}`,
          );
        }
        validateIdent(k, "column");
        const colSql = sql.raw(`"${k}"`);
        wheres.push(sql`${colSql} = ${v}`);
      }
      if (since !== null) {
        if (!declared.has("created_at")) {
          throw new Error(`${scope.label}.list: \`since\` requires a created_at column`);
        }
        wheres.push(sql`"created_at" > ${since}`);
      }
      const whereSql =
        wheres.length === 0 ? sql.raw("") : sql`WHERE ${sql.join(wheres, sql` AND `)}`;
      const orderSql = orderBy
        ? sql.raw(`ORDER BY "${orderBy}" ${orderDir.toUpperCase()}`)
        : sql.raw("");
      const fqTable = sql.raw(`"${schemaName}"."${table}"`);
      const limitSql = sql.raw(`LIMIT ${limit}`);
      return withPluginTx(async (tx) => {
        const rows = (await tx.execute(
          sql`SELECT * FROM ${fqTable} ${whereSql} ${orderSql} ${limitSql}`,
        )) as unknown as T[];
        return rows;
      });
    },

    update: async (table, id, patch) => {
      const tableStr = table as string;
      validateIdent(tableStr, "table");
      const declared = declaredColumnsIn(scope.schemaMap, tableStr);
      if (!declared) {
        throw new Error(
          `${scope.label}.update: table "${tableStr}" not declared in plugin "${plugin.slug}".${scope.schemaLabel}`,
        );
      }
      const sets: ReturnType<typeof sql>[] = [];
      for (const [k, v] of Object.entries(patch)) {
        if (k === "id") continue; // never update id
        if (!declared.has(k)) {
          throw new Error(
            `${scope.label}.update: column "${k}" not declared in plugin "${plugin.slug}".${scope.schemaLabel}.${tableStr}`,
          );
        }
        validateIdent(k, "column");
        const colSql = sql.raw(`"${k}"`);
        sets.push(sql`${colSql} = ${v}`);
      }
      if (sets.length === 0) {
        throw new Error(`${scope.label}.update: patch must include at least one declared column`);
      }
      const fqTable = sql.raw(`"${schemaName}"."${tableStr}"`);
      const setsSql = sql.join(sets, sql`, `);
      await withPluginTx(async (tx) => {
        await tx.execute(sql`UPDATE ${fqTable} SET ${setsSql} WHERE id = ${id}::uuid`);
      });
    },

    delete: async (table, id) => {
      const tableStr = table as string;
      validateIdent(tableStr, "table");
      const declared = declaredColumnsIn(scope.schemaMap, tableStr);
      if (!declared) {
        throw new Error(
          `${scope.label}.delete: table "${tableStr}" not declared in plugin "${plugin.slug}".${scope.schemaLabel}`,
        );
      }
      const fqTable = sql.raw(`"${schemaName}"."${tableStr}"`);
      await withPluginTx(async (tx) => {
        await tx.execute(sql`DELETE FROM ${fqTable} WHERE id = ${id}::uuid`);
      });
    },
  };
}

function makePluginQuery(plugin: LoadedPlugin, infra: PluginHostInfra): PluginQuery {
  return makeScopedQuery(plugin, infra, {
    label: "ctx.query",
    schemaLabel: "schema",
    schemaMap: plugin.definition.schema,
    pool: "public",
  });
}

/**
 * #389 — the plugin's OWN cms_admin schema handle. Identical surface to
 * ctx.query, routed through the ADMIN pool with the same per-plugin
 * session vars, reaching only tables declared in `adminSchema` (their
 * RLS policies scope rows to this plugin's id). Attached by
 * makePluginContext only when the manifest holds `cms_admin_schema`.
 */
function makePluginAdminQuery(plugin: LoadedPlugin, infra: PluginHostInfra): PluginAdminQuery {
  return makeScopedQuery(plugin, infra, {
    label: "ctx.adminQuery",
    schemaLabel: "adminSchema",
    schemaMap: plugin.definition.adminSchema ?? {},
    pool: "admin",
  });
}

// ---------------------------------------------------------------------------
// PluginEvents (#392) — polling access to the domain-event outbox with
// per-plugin cursor persistence. Runs on the ADMIN pool under the
// plugin's session vars; the outbox RLS policy admits actor_kind
// 'plugin' for SELECT and the cursor table is scoped to caelo.plugin_id.
// At-least-once: poll() reads past the cursor, commit() advances it.
// ---------------------------------------------------------------------------

const EVENT_KINDS = new Set([
  "page.created",
  "page.updated",
  "page.deleted",
  "page.published",
  "module.updated",
]);

function makePluginEvents(plugin: LoadedPlugin, infra: PluginHostInfra): PluginEvents {
  assertUuid(plugin.pluginActorId, "caelo.actor_id");
  assertUuid(plugin.pluginId, "caelo.plugin_id");

  async function withPluginAdminTx<T>(
    fn: (tx: Parameters<Parameters<typeof infra.adapter.admin.transaction>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return infra.adapter.admin.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('caelo.actor_kind', 'plugin', true)`);
      await tx.execute(sql`SELECT set_config('caelo.actor_id', ${plugin.pluginActorId}, true)`);
      await tx.execute(sql`SELECT set_config('caelo.plugin_id', ${plugin.pluginId}, true)`);
      return fn(tx);
    });
  }

  return {
    poll: async (opts) => {
      const limit = opts?.limit ?? 100;
      if (limit <= 0 || limit > 1000) {
        throw new Error("ctx.events.poll: limit must be 1..1000");
      }
      const kinds = opts?.kinds ?? [];
      for (const k of kinds) {
        if (!EVENT_KINDS.has(k)) throw new Error(`ctx.events.poll: unknown kind "${k}"`);
      }
      return withPluginAdminTx(async (tx) => {
        let cursor = opts?.cursor;
        if (cursor === undefined) {
          const rows = (await tx.execute(sql`
            SELECT cursor_id::text AS cursor_id FROM plugin_event_cursors
            WHERE plugin_id = ${plugin.pluginId}::uuid
          `)) as unknown as { cursor_id: string }[];
          cursor = rows[0] ? Number(rows[0].cursor_id) : 0;
        }
        const kindFilter =
          kinds.length > 0
            ? sql`AND kind IN (${sql.join(
                kinds.map((k) => sql`${k}`),
                sql`, `,
              )})`
            : sql``;
        const events = (await tx.execute(sql`
          SELECT id::text AS id, kind, entity_id::text AS entity_id,
                 payload, created_at::text AS created_at
          FROM domain_events
          WHERE id > ${cursor} ${kindFilter}
          ORDER BY id ASC
          LIMIT ${limit}
        `)) as unknown as {
          id: string;
          kind: string;
          entity_id: string;
          payload: Record<string, unknown>;
          created_at: string;
        }[];
        const mapped: PluginDomainEvent[] = events.map((e) => ({
          id: Number(e.id),
          kind: e.kind as PluginDomainEvent["kind"],
          entityId: e.entity_id,
          payload: e.payload ?? {},
          createdAt: e.created_at,
        }));
        const nextCursor = mapped.length > 0 ? (mapped.at(-1)?.id ?? cursor) : cursor;
        return { events: mapped, nextCursor };
      });
    },

    commit: async (cursor) => {
      if (!Number.isInteger(cursor) || cursor < 0) {
        throw new Error("ctx.events.commit: cursor must be a non-negative integer");
      }
      await withPluginAdminTx(async (tx) => {
        await tx.execute(sql`
          INSERT INTO plugin_event_cursors (plugin_id, cursor_id, updated_at)
          VALUES (${plugin.pluginId}::uuid, ${cursor}, now())
          ON CONFLICT (plugin_id) DO UPDATE SET
            cursor_id = GREATEST(plugin_event_cursors.cursor_id, EXCLUDED.cursor_id),
            updated_at = now()
        `);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// PluginApi — visitor-side read API. Stub until P12 PR1.4 (gateway) wires it
// to the visitor-facing JSON endpoints. For now any caller that hits this
// outside a gateway-dispatched request gets a clear error.
// ---------------------------------------------------------------------------

function makePluginApi(_plugin: LoadedPlugin, _infra: PluginHostInfra) {
  return {
    list: async () => {
      throw new Error(
        "ctx.api.list: visitor-side read API requires a gateway-dispatched request context.",
      );
    },
    get: async () => {
      throw new Error(
        "ctx.api.get: visitor-side read API requires a gateway-dispatched request context.",
      );
    },
  };
}

// ---------------------------------------------------------------------------
// PluginVisitor — set by the gateway from cookie. When dispatched outside
// the gateway (internal Tier-1 calls / tests), defaults to a system visitor.
// ---------------------------------------------------------------------------

function makePluginVisitor(visitorContext?: VisitorContext): PluginVisitor {
  const mut = visitorContext?.sessionMutation;
  return {
    id: visitorContext?.visitorId ?? "00000000-0000-0000-0000-000000000000",
    publicUserId: null,
    ipHash: "",
    sessionToken: visitorContext?.sessionToken ?? null,
    setSession: (args) => {
      if (!mut) return; // outside-gateway dispatch — no-op
      mut.current = args === null ? { kind: "clear" } : { kind: "set", ...args };
    },
  };
}

// ---------------------------------------------------------------------------
// PluginCaptcha — stub in P12. Returns true on the literal "dev" token + on
// any token in dev mode (NODE_ENV !== "production"). P13 wires real
// Cloudflare Turnstile / hCaptcha + a tiny PoW scheme.
// ---------------------------------------------------------------------------

function makePluginCaptcha(): PluginCaptcha {
  return {
    requireProof: async (token) => {
      if (process.env.NODE_ENV !== "production") return true;
      return token === "dev";
    },
  };
}

// ---------------------------------------------------------------------------
// PluginEmail (P12 PR1.3) — outbound email via configured transport.
// Default no-op stub logs to stderr; bootstrap caller swaps in real SMTP /
// Resend adapter via PluginHostInfra.emailTransport.
// ---------------------------------------------------------------------------

function makePluginEmail(infra: PluginHostInfra): PluginEmail {
  return {
    send: async (args) => {
      const transport = infra.emailTransport;
      if (!transport) {
        console.warn(
          `[plugin-host] ctx.email.send (no transport configured): to=${args.to} subject=${args.subject}`,
        );
        return { messageId: `noop-${Date.now()}` };
      }
      return transport.send(args);
    },
  };
}

// ---------------------------------------------------------------------------
// PluginTheme — read-only tokens.
// ---------------------------------------------------------------------------

function makePluginTheme(): PluginTheme {
  return {
    tokens: Object.freeze({}), // P12 wires real theme tokens from structured_sets
  };
}

// ---------------------------------------------------------------------------
// PluginCms — typed Query API call into cms_admin scoped to the plugin's
// actor row + plugin id. Sets caelo.actor_id / caelo.actor_kind='plugin' /
// caelo.plugin_id session vars via the adapter's existing runOperation path.
// ---------------------------------------------------------------------------

function makePluginCms(plugin: LoadedPlugin, infra: PluginHostInfra): PluginCms {
  return {
    call: async <Input, Output>(opName: string, input: Input): Promise<Output> => {
      const r = await execute(
        infra.registry,
        infra.adapter,
        {
          actorId: plugin.pluginActorId,
          actorKind: "plugin",
          requestId: `plugin-${plugin.slug}`,
          pluginId: plugin.pluginId,
        },
        opName,
        input as unknown,
      );
      if (!r.ok) {
        throw new Error(
          `ctx.cms.call("${opName}") failed: ${r.error.kind}${"message" in r.error ? `: ${(r.error as { message: string }).message}` : ""}`,
        );
      }
      return r.value as Output;
    },
  };
}

// ---------------------------------------------------------------------------
// PluginAi — wraps the host's configured AIProvider.
// ---------------------------------------------------------------------------

function makePluginAi(plugin: LoadedPlugin, infra: PluginHostInfra): PluginAi {
  return {
    complete: async (opts) => {
      if (!infra.aiProvider) {
        throw new Error("ctx.ai.complete: no AI provider configured on the host");
      }
      // P11.6 + P16 — per-plugin AI cost cap pre-flight. Without this a
      // misbehaving Tier-1 plugin could drain the daily AI budget with no
      // per-plugin attribution. The `plugins.ai_cost_cap_microcents`
      // column is NULL by default (uncapped). Lookup failures are
      // swallowed once or twice (DB hiccup shouldn't break a working
      // plugin) but trip fail-closed after `LOOKUP_FAIL_THRESHOLD`
      // consecutive misses — silent bypass under sustained DB pressure
      // would defeat enforcement entirely.
      const capKey = `plugin:${plugin.slug}`;
      try {
        const r = await execute(
          infra.registry,
          infra.adapter,
          {
            actorId: SYSTEM_ACTOR_ID,
            actorKind: "system",
            requestId: `plugin-${plugin.slug}-ai-cap`,
          },
          "ai_calls.aggregate_per_plugin",
          { pluginId: plugin.pluginId },
        );
        if (r.ok) {
          recordCapLookupSuccess(capKey);
          const v = r.value as {
            capExceeded: boolean;
            capMicrocents: number | null;
            last24hMicrocents: number;
          };
          if (v.capExceeded) {
            const capUsd = v.capMicrocents !== null ? (v.capMicrocents / 1e8).toFixed(2) : "0";
            const spentUsd = (v.last24hMicrocents / 1e8).toFixed(2);
            throw new Error(
              `PluginAiCapExceeded: plugin '${plugin.slug}' has spent $${spentUsd} of $${capUsd} cap in the last 24h. Owner can raise the cap at /security/plugins/${plugin.slug}.`,
            );
          }
        } else {
          if (recordCapLookupFailure(capKey)) {
            throw new Error(
              `PluginAiCapLookupUnavailable: cap-lookup for plugin '${plugin.slug}' has failed repeatedly; failing closed to protect the daily budget. Investigate /security/costs.`,
            );
          }
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("PluginAiCapExceeded:")) throw e;
        if (e instanceof Error && e.message.startsWith("PluginAiCapLookupUnavailable:")) throw e;
        if (recordCapLookupFailure(capKey)) {
          throw new Error(
            `PluginAiCapLookupUnavailable: cap-lookup for plugin '${plugin.slug}' has failed repeatedly; failing closed to protect the daily budget. Investigate /security/costs.`,
          );
        }
      }
      return infra.aiProvider.complete(opts);
    },
  };
}

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";

// ---------------------------------------------------------------------------
// PluginSnapshots — wraps emitSnapshot inside an admin tx with the plugin's
// actor identity. Snapshot rows tag actor_id = pluginActorId; revert flows
// already plumbed through P4 work transparently.
// ---------------------------------------------------------------------------

function makePluginSnapshots(plugin: LoadedPlugin, infra: PluginHostInfra): PluginSnapshots {
  const emitter = infra.emitSnapshot;
  if (!emitter) {
    return {
      emit: async () => {
        throw new Error(
          "ctx.snapshots.emit: no emitter wired on the host. The bootstrap caller must pass `emitSnapshot` in PluginHostInfra.",
        );
      },
    };
  }
  return {
    emit: async (args) =>
      infra.adapter.withAdminTransaction(
        {
          actorId: plugin.pluginActorId,
          actorKind: "plugin",
          requestId: `plugin-${plugin.slug}-snapshot`,
          pluginId: plugin.pluginId,
        },
        async (tx) =>
          emitter(tx, {
            actorId: plugin.pluginActorId,
            opKind: args.opKind,
            description: args.description ?? `${plugin.slug}: ${args.opKind}`,
            entities: [{ kind: args.entity.kind, id: args.entity.id, payload: args.payload }],
          }),
      ),
  };
}
