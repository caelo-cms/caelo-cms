// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin configuration storage (epic #1644, R6, issue #1645).
 *
 * A plugin that declares `config` or `entityConfig` gets two host-owned
 * tables in its own cms_admin schema, `caelo_config` and
 * `caelo_entity_config`. They are ordinary private plugin tables, so the
 * branch-aware storage of #508 applies unchanged: a change from a chat is a
 * branch snapshot that shows in the chat's draft, is undone with the chat,
 * reaches main with the Stage and goes live with Publish live.
 *
 * Two rows hold the configuration: the release row (every field with scope
 * `release`, branch-aware) and the immediate row (fields with scope
 * `immediate`, always on main). Keeping them apart is what lets an immediate
 * field change at once while a chat holds an unmerged snapshot of the
 * release row; one row would let the Stage merge write the stale immediate
 * value back.
 *
 * Entity rows have a deterministic id (UUID v5 of kind and entity id), so
 * two chats writing the same entity meet on one row and the row lock
 * serialises them. A chat's first write of an entity creates the row on
 * main with empty values, which means "every field at its default" and
 * changes nothing a visitor or a build sees; the values themselves are the
 * branch snapshot.
 *
 * Stored configuration is data (CLAUDE.md §2): activation writes the
 * defaults; a missing row is an error that names the fix, never a silent
 * default at read time.
 */

import { createHash } from "node:crypto";
import {
  applyConfigPatch,
  type ConfigEntityKind,
  type ConfigLeaf,
  configDefaults,
  configLeaves,
  configPatchSchema,
  configValueSchema,
  entityConfigSchema,
  entityConfigValue,
  type PluginConfigSchema,
  type PluginEntityConfigSchema,
  type PluginIndexMap,
  type PluginSchemaMap,
  patchedLeaves,
  pluginConfigSchema,
  pluginEntityConfigSchema,
} from "@caelo-cms/plugin-sdk";
import {
  defineOperation,
  OperationAbortError,
  type OperationDefinition,
  type OperationRegistry,
  type TransactionRunner,
} from "@caelo-cms/query-api";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  type PluginRowLocker,
  privateInsert,
  privateList,
  privateUpdate,
} from "./private-storage.js";

/** Host-owned table of the configuration rows. */
export const CONFIG_TABLE = "caelo_config";
/** Host-owned table of the per-entity configuration rows. */
export const ENTITY_CONFIG_TABLE = "caelo_entity_config";

const CONFIG_COLUMNS = { id: "uuid", scope: "enum:release,immediate", values: "jsonb" } as const;
const ENTITY_COLUMNS = {
  id: "uuid",
  entity_kind: "enum:page,module,contentInstance,pageType",
  entity_id: "text",
  values: "jsonb",
} as const;

/** The namespace of the host's deterministic row ids (a random v4, fixed forever). */
const NAMESPACE = "3d8e1f52-7c4b-4a3e-9b1d-5f2c6a7e8d90";

/** UUID v5 (RFC 9562 §5.5) of `name` in the host namespace. */
export function hostRowId(name: string): string {
  const ns = Buffer.from(NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(name, "utf8").digest();
  hash[6] = ((hash[6] as number) & 0x0f) | 0x50;
  hash[8] = ((hash[8] as number) & 0x3f) | 0x80;
  const h = hash.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const RELEASE_ROW = hostRowId("config:release");
const IMMEDIATE_ROW = hostRowId("config:immediate");

/** The row id of one entity's configuration. */
export function entityRowId(kind: ConfigEntityKind, entityId: string): string {
  return hostRowId(`entity:${kind}:${entityId}`);
}

/** What a plugin declares that the config storage needs. */
export interface ConfigDeclaration {
  readonly slug: string;
  readonly config?: unknown;
  readonly entityConfig?: unknown;
}

/** The parsed configuration schemas of a plugin (defaults filled in). */
export interface ParsedConfig {
  readonly config: PluginConfigSchema | null;
  readonly entityConfig: PluginEntityConfigSchema | null;
}

/** Parses a plugin's declarations once; throws on a declaration the manifest check should have caught. */
export function parsedConfigOf(def: ConfigDeclaration): ParsedConfig {
  return {
    config: def.config ? pluginConfigSchema.parse(def.config) : null,
    entityConfig: def.entityConfig ? pluginEntityConfigSchema.parse(def.entityConfig) : null,
  };
}

/** The host tables a plugin's admin schema gains for its configuration. */
export function hostConfigTables(def: ConfigDeclaration): {
  tables: PluginSchemaMap;
  indexes: PluginIndexMap;
} {
  const tables: Record<string, Record<string, string>> = {};
  const indexes: Record<string, { columns: string[] }[]> = {};
  if (def.config) tables[CONFIG_TABLE] = { ...CONFIG_COLUMNS };
  if (def.entityConfig) {
    tables[ENTITY_CONFIG_TABLE] = { ...ENTITY_COLUMNS };
    indexes[ENTITY_CONFIG_TABLE] = [{ columns: ["entity_kind"] }];
  }
  return { tables, indexes };
}

/** The plugin's admin schema with the host tables added, for provisioning. */
export function withHostConfigTables(
  def: ConfigDeclaration,
  adminSchema: PluginSchemaMap | undefined,
  indexes: PluginIndexMap | undefined,
): { adminSchema: PluginSchemaMap; indexes: PluginIndexMap | undefined } {
  const host = hostConfigTables(def);
  if (Object.keys(host.tables).length === 0) return { adminSchema: adminSchema ?? {}, indexes };
  return {
    adminSchema: { ...(adminSchema ?? {}), ...host.tables },
    indexes: { ...(indexes ?? {}), ...host.indexes },
  };
}

function schemaName(slug: string): string {
  return `plugin_${slug.replace(/-/g, "_")}`;
}

function refuse(operation: string, message: string): never {
  throw new OperationAbortError({ kind: "HandlerError", operation, message });
}

/** Splits a value into the release part and the immediate part, by each top-level field's scope. */
function splitByScope(
  schema: PluginConfigSchema,
  value: Readonly<Record<string, unknown>>,
): { release: Record<string, unknown>; immediate: Record<string, unknown> } {
  const release: Record<string, unknown> = {};
  const immediate: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema)) {
    if (!(name in value)) continue;
    const isImmediate = field.type !== "group" && field.scope === "immediate";
    (isImmediate ? immediate : release)[name] = value[name];
  }
  return { release, immediate };
}

/** Looks up a loaded plugin's declarations by slug; the host supplies it. */
export type ConfigPluginLookup = (
  slug: string,
) => { readonly pluginId: string; readonly declaration: ConfigDeclaration } | null;

interface Deps {
  readonly lockPluginRow?: PluginRowLocker;
  readonly lookup: ConfigPluginLookup;
}

async function scopeToPlugin(tx: TransactionRunner, pluginId: string): Promise<void> {
  // The tables' RLS policy admits only the plugin's own id. A human, the AI
  // or the system reaching them through these operations acts for the
  // plugin within this transaction, and only for its host tables.
  await tx.execute(sql`SELECT set_config('caelo.plugin_id', ${pluginId}, true)`);
}

function pluginCtx(ctx: ExecutionContext, pluginId: string): ExecutionContext {
  return { ...ctx, pluginId };
}

async function readRows(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  slug: string,
  table: string,
  columns: Readonly<Record<string, string>>,
  ids: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    const rows = await privateList(
      tx,
      ctx,
      { schema: schemaName(slug), table, columns },
      {
        limit: chunk.length,
        orderBy: null,
        orderDir: "asc",
        since: null,
        before: null,
        afterId: null,
        equals: [],
        anyOf: [["id", chunk]],
      },
    );
    for (const row of rows) out.set(String(row.id), row);
  }
  return out;
}

/** The plugin's whole configuration value, as `ctx` sees it (branch first). Throws when nothing is stored. */
export async function readConfigValue(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  slug: string,
  schema: PluginConfigSchema,
): Promise<Record<string, unknown>> {
  const rows = await readRows(tx, ctx, slug, CONFIG_TABLE, CONFIG_COLUMNS, [
    RELEASE_ROW,
    IMMEDIATE_ROW,
  ]);
  const release = rows.get(RELEASE_ROW);
  if (!release) {
    refuse(
      "plugin_config.get",
      `the configuration of plugin "${slug}" is not stored: deactivate and activate the plugin again (Settings → Plugins) so its defaults are written`,
    );
  }
  const value = {
    ...((release.values ?? {}) as Record<string, unknown>),
    ...((rows.get(IMMEDIATE_ROW)?.values ?? {}) as Record<string, unknown>),
  };
  const parsed = configValueSchema(schema).safeParse(value);
  if (!parsed.success) {
    refuse(
      "plugin_config.get",
      `the stored configuration of plugin "${slug}" does not match its schema (${parsed.error.issues[0]?.path.join(".") ?? "?"}: ${parsed.error.issues[0]?.message ?? "?"}): activate the plugin again to migrate it`,
    );
  }
  return parsed.data;
}

/**
 * Writes the defaults, or migrates what is stored to the current schema:
 * a field the new version adds gets its default, a field it dropped is
 * removed, a stored value that no longer validates is reset to the default
 * and reported. Runs on main at activation.
 */
export async function seedConfig(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  slug: string,
  schema: PluginConfigSchema,
  locker: PluginRowLocker | undefined,
): Promise<{ reset: string[] }> {
  const defaults = configDefaults(schema);
  const rows = await readRows(tx, ctx, slug, CONFIG_TABLE, CONFIG_COLUMNS, [
    RELEASE_ROW,
    IMMEDIATE_ROW,
  ]);
  const stored = {
    ...((rows.get(RELEASE_ROW)?.values ?? {}) as Record<string, unknown>),
    ...((rows.get(IMMEDIATE_ROW)?.values ?? {}) as Record<string, unknown>),
  };
  const reset: string[] = [];
  const migrate = (
    fields: PluginConfigSchema,
    have: Record<string, unknown>,
    def: Record<string, unknown>,
    prefix: string,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(fields)) {
      const path = prefix ? `${prefix}.${name}` : name;
      if (field.type === "group") {
        out[name] = migrate(
          field.fields,
          (have[name] ?? {}) as Record<string, unknown>,
          def[name] as Record<string, unknown>,
          path,
        );
        continue;
      }
      if (!(name in have)) {
        out[name] = def[name];
        continue;
      }
      const ok1 = configValueSchema({ [name]: field }).safeParse({ [name]: have[name] }).success;
      out[name] = ok1 ? have[name] : def[name];
      if (!ok1) reset.push(path);
    }
    return out;
  };
  const value = migrate(schema, stored, defaults, "");
  const { release, immediate } = splitByScope(schema, value);
  const t = { schema: schemaName(slug), table: CONFIG_TABLE };
  const write = async (
    rowId: string,
    scope: "release" | "immediate",
    values: Record<string, unknown>,
  ) => {
    const existing = rows.get(rowId);
    if (!existing) {
      const r = await privateInsert(
        tx,
        ctx,
        t,
        ["id", "scope", "values"],
        [sql`${rowId}::uuid`, sql`${scope}`, sql`${sql.param(values)}`],
        locker,
        "plugin_config.seed",
      );
      if (!r.ok) refuse("plugin_config.seed", r.message);
    } else if (JSON.stringify(existing.values) !== JSON.stringify(values)) {
      const r = await privateUpdate(
        tx,
        ctx,
        t,
        rowId,
        { values },
        [sql`"values" = ${sql.param(values)}`],
        locker,
        "plugin_config.seed",
      );
      if (!r.ok) refuse("plugin_config.seed", r.message);
    }
  };
  await write(RELEASE_ROW, "release", release);
  await write(IMMEDIATE_ROW, "immediate", immediate);
  return { reset };
}

/** The leaves a patch touches that need the operator's approval. */
export function gatedLeaves(
  schema: PluginConfigSchema,
  patch: Readonly<Record<string, unknown>>,
): ConfigLeaf[] {
  return patchedLeaves(schema, patch).filter((l) => l.field.gate === "approval");
}

/** What an update did, for the AI and the audit. */
export interface ConfigUpdateResult {
  readonly values: Record<string, unknown>;
  readonly changed: readonly {
    readonly path: string;
    readonly effect: string;
    readonly scope: string;
  }[];
}

/** Applies a merge patch. `allowGated` only for the approved path of a proposal. */
export async function updateConfig(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  slug: string,
  schema: PluginConfigSchema,
  patch: unknown,
  locker: PluginRowLocker | undefined,
  allowGated: boolean,
): Promise<ConfigUpdateResult> {
  const op = "plugin_config.update";
  const parsed = configPatchSchema(schema).safeParse(patch);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(patch)"}: ${i.message}`);
    refuse(
      op,
      `the patch does not fit plugin "${slug}"'s configuration: ${issues.join("; ")}. Read the fields with get_plugin_config.`,
    );
  }
  const gated = gatedLeaves(schema, parsed.data);
  if (gated.length > 0 && !allowGated) {
    refuse(
      op,
      `${gated.map((g) => g.path).join(", ")} need${gated.length === 1 ? "s" : ""} the operator's approval: send ${gated.length === 1 ? "it" : "them"} through propose_plugin_config, the rest with update_plugin_config`,
    );
  }
  const before = await readConfigValue(tx, ctx, slug, schema);
  const after = applyConfigPatch(schema, before, parsed.data);
  const valid = configValueSchema(schema).safeParse(after);
  if (!valid.success)
    refuse(
      op,
      `the result does not validate: ${valid.error.issues[0]?.path.join(".")}: ${valid.error.issues[0]?.message}`,
    );
  const beforeSplit = splitByScope(schema, before);
  const afterSplit = splitByScope(schema, after);
  const t = { schema: schemaName(slug), table: CONFIG_TABLE };
  if (JSON.stringify(beforeSplit.release) !== JSON.stringify(afterSplit.release)) {
    const r = await privateUpdate(
      tx,
      ctx,
      t,
      RELEASE_ROW,
      { values: afterSplit.release },
      [sql`"values" = ${sql.param(afterSplit.release)}`],
      locker,
      op,
    );
    if (!r.ok) refuse(op, r.message);
  }
  if (JSON.stringify(beforeSplit.immediate) !== JSON.stringify(afterSplit.immediate)) {
    // Immediate fields never wait for a Stage: on main, whatever branch the caller is on.
    const main = { ...ctx, chatBranchId: undefined, chatTaskId: undefined };
    const r = await privateUpdate(
      tx,
      main,
      t,
      IMMEDIATE_ROW,
      { values: afterSplit.immediate },
      [sql`"values" = ${sql.param(afterSplit.immediate)}`],
      locker,
      op,
    );
    if (!r.ok) refuse(op, r.message);
  }
  const changed = patchedLeaves(schema, parsed.data).map((l) => ({
    path: l.path,
    effect: l.field.effect,
    scope: l.field.scope,
  }));
  return { values: after, changed };
}

/** Reads entity configuration for many entities; every id gets its effective values. */
export async function readEntityConfig(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  slug: string,
  entityConfig: PluginEntityConfigSchema,
  kind: ConfigEntityKind,
  ids: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  const fields = entityConfig[kind];
  if (!fields)
    refuse("plugin_config.get_entities", `plugin "${slug}" keeps no configuration for ${kind}s`);
  const rows = await readRows(
    tx,
    ctx,
    slug,
    ENTITY_CONFIG_TABLE,
    ENTITY_COLUMNS,
    ids.map((id) => entityRowId(kind, id)),
  );
  const out = new Map<string, Record<string, unknown>>();
  for (const id of ids)
    out.set(
      id,
      entityConfigValue(
        fields,
        rows.get(entityRowId(kind, id))?.values as Record<string, unknown> | undefined,
      ),
    );
  return out;
}

/** Ids of every entity of a kind with at least one stored field. */
export async function configuredEntities(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  slug: string,
  kind: ConfigEntityKind,
): Promise<string[]> {
  const out: string[] = [];
  let afterId: string | null = null;
  for (;;) {
    const rows = await privateList(
      tx,
      ctx,
      { schema: schemaName(slug), table: ENTITY_CONFIG_TABLE, columns: ENTITY_COLUMNS },
      {
        limit: 1000,
        orderBy: null,
        orderDir: "asc",
        since: null,
        before: null,
        afterId,
        equals: [["entity_kind", kind]],
        anyOf: [],
      },
    );
    for (const row of rows)
      if (
        Object.values((row.values ?? {}) as Record<string, unknown>).some(
          (v) => v !== null && v !== undefined,
        )
      )
        out.push(String(row.entity_id));
    if (rows.length < 1000) return out;
    afterId = String(rows[rows.length - 1]?.id).toLowerCase();
  }
}

/** One entity write: fields to set; a field set to null takes its default again. */
export interface EntityConfigWrite {
  readonly kind: ConfigEntityKind;
  readonly id: string;
  readonly values: Readonly<Record<string, unknown>>;
}

/** Writes entity configuration, every item or none. */
export async function setEntityConfig(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  slug: string,
  entityConfig: PluginEntityConfigSchema,
  items: readonly EntityConfigWrite[],
  locker: PluginRowLocker | undefined,
): Promise<{ written: number }> {
  const op = "plugin_config.set_entities";
  const problems: string[] = [];
  items.forEach((item, i) => {
    const fields = entityConfig[item.kind];
    if (!fields) {
      problems.push(`items.${i}.kind: plugin "${slug}" keeps no configuration for ${item.kind}s`);
      return;
    }
    const r = entityConfigSchema(fields).safeParse(item.values);
    if (!r.success)
      for (const issue of r.error.issues.slice(0, 3))
        problems.push(`items.${i}.values.${issue.path.join(".")}: ${issue.message}`);
  });
  if (problems.length > 0) refuse(op, problems.join("; "));
  const t = { schema: schemaName(slug), table: ENTITY_CONFIG_TABLE };
  const byKind = new Map<ConfigEntityKind, EntityConfigWrite[]>();
  for (const item of items)
    (byKind.get(item.kind) ?? byKind.set(item.kind, []).get(item.kind))?.push(item);
  let written = 0;
  for (const [kind, list] of byKind) {
    const existing = await readRows(
      tx,
      ctx,
      slug,
      ENTITY_CONFIG_TABLE,
      ENTITY_COLUMNS,
      list.map((i) => entityRowId(kind, i.id)),
    );
    for (const item of list) {
      const rowId = entityRowId(kind, item.id);
      let row = existing.get(rowId);
      if (!row) {
        // See the file comment: the row exists on main with "all defaults", the change is the branch's.
        const main = { ...ctx, chatBranchId: undefined, chatTaskId: undefined };
        const r = await privateInsert(
          tx,
          main,
          t,
          ["id", "entity_kind", "entity_id", "values"],
          [sql`${rowId}::uuid`, sql`${kind}`, sql`${item.id}`, sql`${sql.param({})}`],
          locker,
          op,
        );
        if (!r.ok) refuse(op, r.message);
        row = { id: rowId, values: {} };
      }
      const merged: Record<string, unknown> = {
        ...((row.values ?? {}) as Record<string, unknown>),
      };
      for (const [k, v] of Object.entries(item.values)) {
        if (v === null || v === undefined) delete merged[k];
        else merged[k] = v;
      }
      if (JSON.stringify(merged) === JSON.stringify(row.values ?? {})) continue;
      const r = await privateUpdate(
        tx,
        ctx,
        t,
        rowId,
        { values: merged },
        [sql`"values" = ${sql.param(merged)}`],
        locker,
        op,
      );
      if (!r.ok) refuse(op, r.message);
      written++;
    }
  }
  return { written };
}

const slugInput = z.string().regex(/^[a-z][a-z0-9-]{0,54}$/);
const entityKind = z.enum(["page", "module", "contentInstance", "pageType"]);

/** Names of the configuration operations. */
export const CONFIG_OPS = {
  get: "plugin_config.get",
  update: "plugin_config.update",
  getEntities: "plugin_config.get_entities",
  setEntities: "plugin_config.set_entities",
  seed: "plugin_config.seed",
} as const;

function declared(
  deps: Deps,
  op: string,
  slug: string,
): { pluginId: string; parsed: ParsedConfig } {
  const found = deps.lookup(slug);
  if (!found)
    refuse(
      op,
      `plugin "${slug}" is not active: list_plugins shows which plugins are installed, and an Owner activates one in Settings → Plugins`,
    );
  return { pluginId: found.pluginId, parsed: parsedConfigOf(found.declaration) };
}

/** Defines the configuration operations. */
export function makeConfigOps(deps: Deps): OperationDefinition<unknown, unknown>[] {
  const get = defineOperation({
    name: CONFIG_OPS.get,
    readScope: "request",
    actorScope: ["human", "ai", "system", "plugin"],
    database: "cms_admin",
    input: z.object({ pluginSlug: slugInput }).strict(),
    output: z.object({ values: z.record(z.string(), z.unknown()) }),
    handler: async (ctx, input, tx) => {
      const { pluginId, parsed } = declared(deps, CONFIG_OPS.get, input.pluginSlug);
      if (!parsed.config)
        refuse(CONFIG_OPS.get, `plugin "${input.pluginSlug}" declares no configuration`);
      if (ctx.actorKind === "plugin" && ctx.pluginId !== pluginId)
        refuse(CONFIG_OPS.get, "a plugin reads only its own configuration");
      await scopeToPlugin(tx, pluginId);
      return ok({
        values: await readConfigValue(
          tx,
          pluginCtx(ctx, pluginId),
          input.pluginSlug,
          parsed.config,
        ),
      });
    },
  });
  const update = defineOperation({
    name: CONFIG_OPS.update,
    readScope: "request",
    // Why not plugin: a plugin's configuration is the operator's decision; the plugin reads it.
    actorScope: ["human", "ai", "system"],
    database: "cms_admin",
    input: z
      .object({
        pluginSlug: slugInput,
        patch: z.record(z.string(), z.unknown()),
        approved: z.boolean().default(false),
      })
      .strict(),
    output: z.object({
      values: z.record(z.string(), z.unknown()),
      changed: z.array(z.object({ path: z.string(), effect: z.string(), scope: z.string() })),
    }),
    handler: async (ctx, input, tx) => {
      const { pluginId, parsed } = declared(deps, CONFIG_OPS.update, input.pluginSlug);
      if (!parsed.config)
        refuse(CONFIG_OPS.update, `plugin "${input.pluginSlug}" declares no configuration`);
      // `approved` is honoured only for the approval path's human actor (plugin_config.execute_proposal).
      const allowGated = input.approved && ctx.actorKind === "human";
      await scopeToPlugin(tx, pluginId);
      return ok(
        await updateConfig(
          tx,
          pluginCtx(ctx, pluginId),
          input.pluginSlug,
          parsed.config,
          input.patch,
          deps.lockPluginRow,
          allowGated,
        ),
      );
    },
  });
  const getEntities = defineOperation({
    name: CONFIG_OPS.getEntities,
    readScope: "request",
    actorScope: ["human", "ai", "system", "plugin"],
    database: "cms_admin",
    input: z
      .object({
        pluginSlug: slugInput,
        kind: entityKind,
        ids: z.array(z.string().min(1).max(200)).max(5000).optional(),
        configuredOnly: z.boolean().default(false),
      })
      .strict(),
    output: z.object({
      entities: z.array(z.object({ id: z.string(), values: z.record(z.string(), z.unknown()) })),
    }),
    handler: async (ctx, input, tx) => {
      const { pluginId, parsed } = declared(deps, CONFIG_OPS.getEntities, input.pluginSlug);
      if (!parsed.entityConfig)
        refuse(
          CONFIG_OPS.getEntities,
          `plugin "${input.pluginSlug}" declares no entity configuration`,
        );
      if (ctx.actorKind === "plugin" && ctx.pluginId !== pluginId)
        refuse(CONFIG_OPS.getEntities, "a plugin reads only its own configuration");
      await scopeToPlugin(tx, pluginId);
      const pctx = pluginCtx(ctx, pluginId);
      const ids =
        input.configuredOnly || !input.ids
          ? await configuredEntities(tx, pctx, input.pluginSlug, input.kind)
          : input.ids;
      const values = await readEntityConfig(
        tx,
        pctx,
        input.pluginSlug,
        parsed.entityConfig,
        input.kind,
        ids,
      );
      return ok({ entities: [...values.entries()].map(([id, v]) => ({ id, values: v })) });
    },
  });
  const setEntities = defineOperation({
    name: CONFIG_OPS.setEntities,
    readScope: "request",
    // Why not plugin: see update.
    actorScope: ["human", "ai", "system"],
    database: "cms_admin",
    input: z
      .object({
        pluginSlug: slugInput,
        items: z
          .array(
            z
              .object({
                kind: entityKind,
                id: z.string().min(1).max(200),
                values: z.record(z.string(), z.unknown()),
              })
              .strict(),
          )
          .min(1)
          .max(500),
      })
      .strict(),
    output: z.object({ written: z.number().int() }),
    handler: async (ctx, input, tx) => {
      const { pluginId, parsed } = declared(deps, CONFIG_OPS.setEntities, input.pluginSlug);
      if (!parsed.entityConfig)
        refuse(
          CONFIG_OPS.setEntities,
          `plugin "${input.pluginSlug}" declares no entity configuration`,
        );
      await scopeToPlugin(tx, pluginId);
      return ok(
        await setEntityConfig(
          tx,
          pluginCtx(ctx, pluginId),
          input.pluginSlug,
          parsed.entityConfig,
          input.items,
          deps.lockPluginRow,
        ),
      );
    },
  });
  const seed = defineOperation({
    name: CONFIG_OPS.seed,
    readScope: "request",
    // Why system-only: activation writes the defaults on main; nobody else seeds.
    actorScope: ["system"],
    database: "cms_admin",
    input: z.object({ pluginSlug: slugInput }).strict(),
    output: z.object({ reset: z.array(z.string()) }),
    handler: async (ctx, input, tx) => {
      const { pluginId, parsed } = declared(deps, CONFIG_OPS.seed, input.pluginSlug);
      if (!parsed.config) return ok({ reset: [] });
      await scopeToPlugin(tx, pluginId);
      return ok(
        await seedConfig(
          tx,
          { ...pluginCtx(ctx, pluginId), chatBranchId: undefined, chatTaskId: undefined },
          input.pluginSlug,
          parsed.config,
          deps.lockPluginRow,
        ),
      );
    },
  });
  return [get, update, getEntities, setEntities, seed] as unknown as OperationDefinition<
    unknown,
    unknown
  >[];
}

/** Registers the configuration operations once. */
export function registerPluginConfigOps(registry: OperationRegistry, deps: Deps): void {
  for (const op of makeConfigOps(deps)) if (!registry.has(op.name)) registry.register(op);
}

/** Every leaf path with its metadata, for the AI's get tool and the generated form. */
export function describeConfig(schema: PluginConfigSchema): {
  path: string;
  type: string;
  label: string;
  description: string;
  effect: string;
  gate: string;
  scope: string;
}[] {
  return configLeaves(schema).map((l) => ({
    path: l.path,
    type: l.field.type,
    label: l.field.label,
    description: l.field.description,
    effect: l.field.effect,
    gate: l.field.gate,
    scope: l.field.scope,
  }));
}

/** The lookup over the host's loaded plugins: active (loaded and not disabled) plugins only. */
export function loadedConfigLookup(
  byslug: (
    slug: string,
  ) => { readonly pluginId: string; readonly definition: ConfigDeclaration } | undefined,
  isDisabled: (slug: string) => boolean,
): ConfigPluginLookup {
  return (slug) => {
    const p = byslug(slug);
    if (!p || isDisabled(slug)) return null;
    return { pluginId: p.pluginId, declaration: p.definition };
  };
}
