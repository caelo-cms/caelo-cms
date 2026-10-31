// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/published-state — what the plugin host reads in
 * the public API gateway, which has NO cms_admin login (issue #635,
 * CLAUDE.md §2 "the public side has no path to cms_admin").
 *
 * The admin publishes a declared projection of authoring state into
 * cms_public (`@caelo-cms/migrations/public-projection`); the gateway's
 * host reads only that:
 *
 *   - the active-plugin registry and, for runtime-authored plugins, their
 *     reviewed source and capability receipts (`published_plugins`,
 *     `published_plugin_grants`);
 *   - each plugin's declared `visitorProjection` of its private storage
 *     (`published_plugin_rows`), behind a READ-ONLY `ctx.adminQuery`;
 *   - and it writes the plugin op audit of visitor calls into
 *     `gateway_plugin_op_events`, which the admin reads back only as an
 *     untrusted hint (docs/dev/public-admin-boundary.md).
 *
 * A host is in this mode exactly when its adapter has no cms_admin pool
 * (`adapter.hasAdminDatabase === false`) — there is no flag to forget.
 * A section the admin has not published yet is a loud
 * {@link ProjectionNotPublishedError}, never an empty answer: "no plugin is
 * active" and "nobody told us yet" must not look alike.
 *
 * These reads (and the op-event insert) are fixed SQL run through the
 * adapter's `withPublicTransaction` as the `system` actor rather than
 * Query API ops: the gateway has no op registry for cms_public state, the
 * statements take no identifier from a caller, and RLS on every table
 * (cms_public 0280) still bounds what public_role can see or write. A
 * visitor call is audited by the op event this module writes.
 */

import { externalArtifactDigest } from "@caelo-cms/plugin-sandbox";
import type { PluginAdminQuery, PluginQueryFilter } from "@caelo-cms/plugin-sdk";
import type { TransactionRunner } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { LoadedPlugin, PluginHostInfra } from "./dispatch.js";
import { sameValue } from "./private-storage.js";

/** A projection section the admin has not published yet (fresh install, upgrade in flight). */
export class ProjectionNotPublishedError extends Error {
  override readonly name = "ProjectionNotPublishedError";
  constructor(readonly section: string) {
    super(
      `ProjectionNotPublished: the admin has not published "${section}" into cms_public yet — run the database migrations (they publish it) or start the admin`,
    );
  }
}

/**
 * Whether `e` says a section is not published. A runtime-authored plugin
 * runs in a sandbox subprocess, so its error may come back as a message
 * only; the message prefix is part of the contract.
 */
export function isProjectionNotPublished(e: unknown): boolean {
  return (
    e instanceof ProjectionNotPublishedError ||
    (e instanceof Error && /\bProjectionNotPublished: /.test(e.message))
  );
}

let unpublishedRegistry: ProjectionNotPublishedError | null = null;

/**
 * Record the outcome of the gateway's last registry read: the error when
 * the admin has not published the `plugins` section, else null. Until it
 * is published the gateway cannot know which plugins exist, so a request
 * for any plugin is "not published" (503), never "no such plugin" (404).
 */
export function setUnpublishedRegistry(e: ProjectionNotPublishedError | null): void {
  unpublishedRegistry = e;
}

/** The pending "not published" error of the registry, if any (see {@link setUnpublishedRegistry}). */
export function unpublishedRegistryError(): ProjectionNotPublishedError | null {
  return unpublishedRegistry;
}

/** Whether this host runs on the public side (no cms_admin pool). */
export function isPublicSideHost(infra: PluginHostInfra): boolean {
  return infra.adapter.hasAdminDatabase === false;
}

async function assertPublished(tx: TransactionRunner, section: string): Promise<void> {
  const rows = (await tx.execute(
    sql`SELECT 1 AS ok FROM published_projection_sections WHERE section = ${section}`,
  )) as unknown as unknown[];
  if (rows.length === 0) throw new ProjectionNotPublishedError(section);
}

function readCtx(systemActorId: string, requestId: string): ExecutionContext {
  return { actorId: systemActorId, actorKind: "system", requestId };
}

/** One active plugin as the admin published it. */
export interface PublishedPluginRow {
  readonly id: string;
  readonly slug: string;
  readonly tier: number;
  readonly status: "active";
  readonly version: string;
  readonly actor_id: string | null;
  /**
   * #1267 — a release-signed plugin's Owner-approved capability set
   * (`plugins.approved_capabilities`); null when nothing is approved, and
   * always null for runtime-authored plugins (their grants are receipts).
   */
  readonly approved_capabilities: readonly string[] | null;
}

const approvedCapabilitiesSchema = z.array(z.string().min(1).max(64)).max(64).nullable();

/** The active-plugin registry the admin published. */
export async function readPublishedRegistry(
  infra: PluginHostInfra,
  systemActorId: string,
): Promise<PublishedPluginRow[]> {
  return infra.adapter.withPublicTransaction(
    readCtx(systemActorId, "gateway-plugin-sync"),
    async (tx) => {
      await assertPublished(tx, "plugins");
      const rows = (await tx.execute(sql`
        SELECT id::text AS id, slug, tier, version, actor_id::text AS actor_id,
               approved_capabilities
        FROM published_plugins
      `)) as unknown as (Omit<PublishedPluginRow, "status" | "approved_capabilities"> & {
        approved_capabilities: unknown;
      })[];
      // cms_public is attacker-writable (#635): validate what the gate reads.
      return rows.map((r) => ({
        ...r,
        tier: Number(r.tier),
        status: "active" as const,
        approved_capabilities: approvedCapabilitiesSchema.parse(r.approved_capabilities ?? null),
      }));
    },
  );
}

/** A runtime-authored plugin's reviewed manifest + source, as published. */
export async function readPublishedArtifact(
  infra: PluginHostInfra,
  systemActorId: string,
  pluginId: string,
): Promise<{ manifest_json: unknown; source_code: string | null } | null> {
  return infra.adapter.withPublicTransaction(
    readCtx(systemActorId, "gateway-plugin-artifact"),
    async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT manifest_json, source_code FROM published_plugins WHERE id = ${pluginId}::uuid
      `)) as unknown as { manifest_json: unknown; source_code: string | null }[];
      return rows[0] ?? null;
    },
  );
}

/**
 * The approval state of an installed plugin, from the published registry:
 * the same shape (and the same digest rule) as the admin's
 * `plugin_external.approval` operation.
 */
export async function readPublishedApprovalState(
  infra: PluginHostInfra,
  systemActorId: string,
  pluginId: string,
): Promise<{
  active: boolean;
  artifactDigest: string | null;
  manifest: unknown;
  grants: { id: string; capability: string }[];
}> {
  return infra.adapter.withPublicTransaction(
    readCtx(systemActorId, "gateway-plugin-approval"),
    async (tx) => {
      await assertPublished(tx, "plugins");
      const rows = (await tx.execute(sql`
        SELECT manifest_json, source_code FROM published_plugins WHERE id = ${pluginId}::uuid
      `)) as unknown as { manifest_json: unknown; source_code: string | null }[];
      const row = rows[0];
      if (!row || row.source_code === null) {
        return { active: false, artifactDigest: null, manifest: null, grants: [] };
      }
      const artifactDigest = externalArtifactDigest(row.manifest_json, row.source_code);
      const grants = (await tx.execute(sql`
        SELECT id::text AS id, capability FROM published_plugin_grants
        WHERE plugin_id = ${pluginId}::uuid AND artifact_digest = ${artifactDigest}
        ORDER BY id
      `)) as unknown as { id: string; capability: string }[];
      return { active: true, artifactDigest, manifest: row.manifest_json, grants };
    },
  );
}

const projectedRow = z.record(z.string(), z.unknown());

/**
 * The gateway's `ctx.adminQuery`: a READ-ONLY handle over the plugin's
 * declared `visitorProjection`. Same `list` surface as private storage
 * (equality filters, `orderBy`, `limit`, `since` on a projected
 * `created_at`), evaluated over the published main-line rows. Every write
 * throws — a visitor request never writes author data (CMS_REQUIREMENTS
 * §14.7) — and so does any table or column outside the declaration.
 */
export function makeProjectedAdminQuery(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
): PluginAdminQuery {
  const projection = plugin.definition.visitorProjection ?? {};
  const label = `ctx.adminQuery (visitor projection of "${plugin.slug}")`;
  const refuse = (method: string) => async (): Promise<never> => {
    throw new Error(
      `${label}.${method}: the public side cannot write private storage — write from a chat tool, the Owner panel, a worker or onActivate`,
    );
  };
  function columnsOf(table: string): Set<string> {
    const cols = projection[table];
    if (!cols) {
      throw new Error(
        `${label}.list: table "${table}" is not in the plugin's visitorProjection — declare it there if visitor operations genuinely need it`,
      );
    }
    return new Set(["id", ...cols]);
  }
  return {
    list: async <T = Record<string, unknown>>(
      table: string,
      filter?: PluginQueryFilter,
    ): Promise<T[]> => {
      const columns = columnsOf(table);
      const { limit = 100, orderBy, orderDir = "asc", since, before, ...equals } = filter ?? {};
      for (const k of [...Object.keys(equals), ...(orderBy ? [orderBy] : [])]) {
        if (!columns.has(k)) {
          throw new Error(`${label}.list: column "${k}" is not in visitorProjection.${table}`);
        }
      }
      for (const [k, v] of [
        ["since", since],
        ["before", before],
      ] as const) {
        if (v !== undefined && !columns.has("created_at")) {
          throw new Error(`${label}.list: \`${k}\` needs created_at in visitorProjection.${table}`);
        }
      }
      if (typeof limit !== "number" || limit <= 0 || limit > 1000) {
        throw new Error(`${label}.list: limit must be 1..1000`);
      }
      const found = await infra.adapter.withPublicTransaction(
        {
          actorId: plugin.pluginActorId,
          actorKind: "plugin",
          pluginId: plugin.pluginId,
          requestId: `plugin-${plugin.slug}-projection`,
        },
        async (tx) => {
          await assertPublished(tx, `plugin:${plugin.pluginId}`);
          return (await tx.execute(sql`
            SELECT row FROM published_plugin_rows
            WHERE plugin_id = ${plugin.pluginId}::uuid AND table_name = ${table}
          `)) as unknown as { row: unknown }[];
        },
      );
      let out = found.map((r) => projectedRow.parse(r.row));
      out = out.filter((r) => Object.entries(equals).every(([k, v]) => sameValue(r[k], v)));
      if (typeof since === "string") {
        out = out.filter((r) => Date.parse(String(r.created_at)) > Date.parse(since));
      }
      if (typeof before === "string") {
        out = out.filter((r) => Date.parse(String(r.created_at)) < Date.parse(before));
      }
      if (typeof orderBy === "string") {
        const dir = orderDir === "desc" ? -1 : 1;
        out.sort((a, b) => dir * compareValues(a[orderBy], b[orderBy]));
      }
      return out.slice(0, limit) as T[];
    },
    insert: refuse("insert"),
    update: refuse("update"),
    delete: refuse("delete"),
    compareAndSwap: refuse("compareAndSwap"),
  };
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : 1;
}

/**
 * The gateway's plugin op audit (#635): one row per successful visitor
 * call, in cms_public. The admin reads it back only for the plugin-data
 * build (#1155), and treats every row as an UNTRUSTED hint: a page id
 * counts only for a declared baked-data trigger of a plugin the admin runs
 * and a page that exists (admin-core `plugin-data/visitor-hints.ts`). The operator's audit trail of authoring actions
 * stays in cms_admin, where the public side cannot forge rows (#763 L7).
 */
export async function emitPublicPluginOpEvent(
  infra: PluginHostInfra,
  args: {
    readonly pluginId: string;
    readonly actorId: string;
    readonly operation: string;
    readonly inputHash: string;
    readonly entityId: string | null;
    /** #1155 — the page a declared baked-data trigger named (an untrusted hint for the admin). */
    readonly pageId: string | null;
  },
): Promise<void> {
  await infra.adapter.withPublicTransaction(
    {
      actorId: args.actorId,
      actorKind: "plugin",
      pluginId: args.pluginId,
      requestId: `plugin-op-event-${args.operation}`,
    },
    async (tx) => {
      await tx.execute(sql`
        INSERT INTO gateway_plugin_op_events (plugin_id, operation, input_hash, succeeded, entity_id,
                                              page_id)
        VALUES (${args.pluginId}::uuid, ${args.operation}, ${args.inputHash}, true,
                ${args.entityId === null ? null : sql`${args.entityId}::uuid`},
                ${args.pageId === null ? null : sql`${args.pageId}::uuid`})
      `);
    },
  );
}
