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
 * Tier 2 plugins NEVER get these — the loader passes Tier-2 to this module
 * via `tier: 2` and the function returns the locked `PluginContext` only.
 */

import type {
  PluginAi,
  PluginCapability,
  PluginCaptcha,
  PluginCms,
  PluginContext,
  PluginContextTier1,
  PluginEmail,
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
  readonly locale: string;
  readonly sessionToken: string | null;
  readonly sessionMutation?: { current: SessionMutation };
}

export type SessionMutation =
  | { kind: "none" }
  | { kind: "set"; sessionToken: string; expiresAt: string }
  | { kind: "clear" };

/**
 * Build the per-call context. Returns a locked PluginContext for Tier 2 and
 * an extended PluginContextTier1 for Tier 1 (with only the requested
 * capability handles attached).
 */
export async function makePluginContext(
  opts: MakePluginContextOpts,
): Promise<PluginContext | PluginContextTier1> {
  const { plugin, infra, visitorContext } = opts;
  const requested = new Set<PluginCapability>(plugin.definition.requestedCapabilities ?? []);

  const baseCtx: PluginContext = {
    query: makePluginQuery(plugin, infra),
    api: makePluginApi(plugin, infra),
    theme: makePluginTheme(visitorContext),
    visitor: makePluginVisitor(visitorContext),
    captcha: makePluginCaptcha(),
  };

  if (plugin.tier === 2) return baseCtx;

  // Tier 1 — attach elevated handles per requestedCapabilities.
  const tier1: Mutable<PluginContextTier1> = { ...baseCtx };
  if (requested.has("cms_admin")) {
    tier1.cms = makePluginCms(plugin, infra);
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

function declaredColumnsOf(plugin: LoadedPlugin, table: string): Set<string> | null {
  const tableSpec = plugin.definition.schema[table];
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

function makePluginQuery(plugin: LoadedPlugin, infra: PluginHostInfra): PluginQuery {
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
    return infra.adapter.public.transaction(async (tx) => {
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
      const declared = declaredColumnsOf(plugin, tableStr);
      if (!declared) {
        throw new Error(
          `ctx.query.insert: table "${tableStr}" not declared in plugin "${plugin.slug}".schema`,
        );
      }
      const cols: string[] = [];
      const valueFragments: ReturnType<typeof sql>[] = [];
      for (const [k, v] of Object.entries(data)) {
        if (!declared.has(k)) {
          throw new Error(
            `ctx.query.insert: column "${k}" not declared in plugin "${plugin.slug}".schema.${tableStr}`,
          );
        }
        validateIdent(k, "column");
        cols.push(`"${k}"`);
        valueFragments.push(sql`${v}`);
      }
      if (cols.length === 0) {
        throw new Error("ctx.query.insert: data must include at least one declared column");
      }
      const colsSql = sql.raw(cols.join(", "));
      const valuesSql = sql.join(valueFragments, sql`, `);
      const fqTable = sql.raw(`"${schemaName}"."${tableStr}"`);
      return withPluginTx(async (tx) => {
        const rows = (await tx.execute(
          sql`INSERT INTO ${fqTable} (${colsSql}) VALUES (${valuesSql}) RETURNING id::text AS id`,
        )) as unknown as { id: string }[];
        const id = rows[0]?.id;
        if (!id) throw new Error("ctx.query.insert: no id returned");
        return { id };
      });
    },

    list: async <T = Record<string, unknown>>(
      table: string,
      filter?: PluginQueryFilter,
    ): Promise<T[]> => {
      validateIdent(table, "table");
      const declared = declaredColumnsOf(plugin, table);
      if (!declared) {
        throw new Error(
          `ctx.query.list: table "${table}" not declared in plugin "${plugin.slug}".schema`,
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
            throw new Error("ctx.query.list: limit must be 1..1000");
          }
          limit = v;
          continue;
        }
        if (k === "orderBy") {
          if (typeof v !== "string") throw new Error("ctx.query.list: orderBy must be string");
          if (!declared.has(v)) {
            throw new Error(`ctx.query.list: orderBy "${v}" not declared in schema`);
          }
          validateIdent(v, "column");
          orderBy = v;
          continue;
        }
        if (k === "orderDir") {
          if (v !== "asc" && v !== "desc")
            throw new Error("ctx.query.list: orderDir must be asc|desc");
          orderDir = v;
          continue;
        }
        if (k === "since") {
          if (typeof v !== "string")
            throw new Error("ctx.query.list: since must be ISO timestamp string");
          since = v;
          continue;
        }
        if (!declared.has(k)) {
          throw new Error(
            `ctx.query.list: column "${k}" not declared in plugin "${plugin.slug}".schema.${table}`,
          );
        }
        validateIdent(k, "column");
        const colSql = sql.raw(`"${k}"`);
        wheres.push(sql`${colSql} = ${v}`);
      }
      if (since !== null) {
        if (!declared.has("created_at")) {
          throw new Error("ctx.query.list: `since` requires a created_at column");
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
      const declared = declaredColumnsOf(plugin, tableStr);
      if (!declared) {
        throw new Error(
          `ctx.query.update: table "${tableStr}" not declared in plugin "${plugin.slug}".schema`,
        );
      }
      const sets: ReturnType<typeof sql>[] = [];
      for (const [k, v] of Object.entries(patch)) {
        if (k === "id") continue; // never update id
        if (!declared.has(k)) {
          throw new Error(
            `ctx.query.update: column "${k}" not declared in plugin "${plugin.slug}".schema.${tableStr}`,
          );
        }
        validateIdent(k, "column");
        const colSql = sql.raw(`"${k}"`);
        sets.push(sql`${colSql} = ${v}`);
      }
      if (sets.length === 0) {
        throw new Error("ctx.query.update: patch must include at least one declared column");
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
      const declared = declaredColumnsOf(plugin, tableStr);
      if (!declared) {
        throw new Error(
          `ctx.query.delete: table "${tableStr}" not declared in plugin "${plugin.slug}".schema`,
        );
      }
      const fqTable = sql.raw(`"${schemaName}"."${tableStr}"`);
      await withPluginTx(async (tx) => {
        await tx.execute(sql`DELETE FROM ${fqTable} WHERE id = ${id}::uuid`);
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
    locale: visitorContext?.locale ?? "en",
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
        // biome-ignore lint/suspicious/noConsole: stub visibility for dev
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
// PluginTheme — read-only tokens + locale. Visitor-context-aware.
// ---------------------------------------------------------------------------

function makePluginTheme(visitorContext?: { locale: string }): PluginTheme {
  return {
    tokens: Object.freeze({}), // P12 wires real theme tokens from structured_sets
    locale: visitorContext?.locale ?? "en",
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
