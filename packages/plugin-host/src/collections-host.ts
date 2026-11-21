// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin collections on the admin side (epic #1644, R2, issue #1648):
 * `ctx.collections` and the operations behind it.
 *
 * A write is not visible at once. It becomes a change file in the staging
 * collection store and a `collection_changes` row; the next Stage's index
 * job applies every change of the plugin's collection in order and writes
 * the new release. A write from a page-output observer belongs to that
 * observer's Stage; every other write waits for the next Stage.
 *
 * Who may write: the observer, batch jobs, workers, the Owner panel, an
 * approved action and the system (all on main). A chat may not: a
 * collection is derived from what the site publishes, so a chat changes
 * the pages or the plugin's settings, and the next Stage re-derives it.
 */

import { deflateRawSync, inflateRawSync } from "node:zlib";
import {
  type CollectionStore,
  FileCache,
  idTerm,
  lookupDocs,
  openRelease,
  parseRelease,
  storeFromUrl,
} from "@caelo-cms/collection-index";
import {
  type CollectionDocInput,
  type PluginCollectionHandle,
  type PluginCollectionManifest,
  type PluginCollections,
  type PluginInvocation,
  type SearchProfile,
  type SearchProfileInput,
  searchProfile,
} from "@caelo-cms/plugin-sdk";
import {
  defineOperation,
  execute,
  OperationAbortError,
  type OperationDefinition,
  type OperationRegistry,
} from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  isPluginDisabled,
  type LoadedPlugin,
  loadedPlugins,
  type PluginHostInfra,
} from "./dispatch.js";

/** The env var naming the staging collection store (the admin and the index job). */
export const STAGING_COLLECTION_STORE_ENV = "CAELO_COLLECTIONS_STAGING_STORE";
/** The env var naming the live collection store (the admin's Publish live copy, the live gateway). */
export const LIVE_COLLECTION_STORE_ENV = "CAELO_COLLECTIONS_LIVE_STORE";

const stores = new Map<string, CollectionStore>();

/** The store an env var names; a loud error naming the variable when it is unset. */
export function collectionStoreFromEnv(
  envVar: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): CollectionStore {
  const url = env[envVar];
  if (!url) {
    throw new Error(
      `${envVar} is not set: plugin collections need their store (the install sets it from the stack; self-hosted: a file:// directory)`,
    );
  }
  let store = stores.get(url);
  if (!store) {
    store = storeFromUrl(url);
    stores.set(url, store);
  }
  return store;
}

/** For tests: forget the cached stores. */
export function resetCollectionStores(): void {
  stores.clear();
}

/** The store key prefix of one collection. */
export function collectionPrefix(slug: string, collection: string): string {
  return `${slug}/${collection}`;
}

const MAX_UPSERTS = 500;
const MAX_DELETES = 1000;

/** Zod for one document of a declared collection. */
export function collectionDocSchema(decl: PluginCollectionManifest): z.ZodType<CollectionDocInput> {
  const values: Record<string, z.ZodType> = {};
  for (const [name, spec] of Object.entries(decl.fields)) {
    switch (spec.kind) {
      case "text":
        values[name] = z.string().max(500_000).nullable().optional();
        break;
      case "passages":
        values[name] = z
          .array(
            z
              .object({
                anchor: z.string().max(200),
                heading: z.string().max(2000),
                text: z.string().max(200_000),
              })
              .strict(),
          )
          .max(2000)
          .nullable()
          .optional();
        break;
      case "keyword":
        values[name] = z
          .union([z.string().max(500), z.array(z.string().max(500)).max(200)])
          .nullable()
          .optional();
        break;
      case "number":
        values[name] = z.number().finite().nullable().optional();
        break;
      case "date":
        values[name] = z
          .union([
            z
              .string()
              .max(40)
              .refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO date"),
            z.number().finite(),
          ])
          .nullable()
          .optional();
        break;
    }
  }
  return z
    .object({
      id: z.string().min(1).max(200),
      lang: z
        .string()
        .regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/, "must be a language tag like de or en-GB"),
      values: z.object(values).strict(),
    })
    .strict() as unknown as z.ZodType<CollectionDocInput>;
}

function refuse(operation: string, message: string): never {
  throw new OperationAbortError({ kind: "HandlerError", operation, message });
}

function declaredCollection(
  op: string,
  pluginId: string | undefined,
  collection: string,
): { plugin: LoadedPlugin; decl: PluginCollectionManifest } {
  const plugin = pluginId ? loadedPlugins.byId(pluginId) : undefined;
  if (!plugin || isPluginDisabled(plugin.slug))
    refuse(op, "only an active plugin writes its own collections");
  const decl = plugin.definition.collections?.[collection];
  if (!decl) refuse(op, `plugin "${plugin.slug}" declares no collection "${collection}"`);
  return { plugin, decl };
}

/** What one change file holds. */
export interface CollectionChangeFile {
  readonly upserts: readonly CollectionDocInput[];
  readonly deletes: readonly string[];
  readonly replaceAll: boolean;
  /** A new search profile, validated (absent: unchanged). */
  readonly profile?: SearchProfile;
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** Encodes a change file. */
export function encodeChangeFile(change: CollectionChangeFile): Uint8Array {
  return deflateRawSync(utf8.encode(JSON.stringify(change)), { level: 6 });
}

/** Decodes a change file. */
export function decodeChangeFile(data: Uint8Array): CollectionChangeFile {
  return JSON.parse(utf8Decoder.decode(inflateRawSync(data))) as CollectionChangeFile;
}

/** Names of the collection operations. */
export const COLLECTION_OPS = {
  write: "collections.write_changes",
  get: "collections.get_doc",
} as const;

/** Defines the collection operations. `store` resolves the staging store (env in production, a directory in tests). */
export function makeCollectionOps(
  store: () => CollectionStore,
): OperationDefinition<unknown, unknown>[] {
  const write = defineOperation({
    name: COLLECTION_OPS.write,
    readScope: "request",
    // Why plugin-only: a plugin writes only its own collections (RLS on
    // collection_changes admits a plugin actor's own plugin_id only).
    actorScope: ["plugin"],
    database: "cms_admin",
    input: z
      .object({
        collection: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
        upserts: z.array(z.unknown()).max(MAX_UPSERTS),
        deletes: z.array(z.string().min(1).max(200)).max(MAX_DELETES),
        replaceAll: z.boolean().default(false),
        profile: z.unknown().optional(),
        stageRunId: z.string().uuid().optional(),
      })
      .strict(),
    output: z.object({ changeId: z.string() }),
    handler: async (ctx, input, tx) => {
      const op = COLLECTION_OPS.write;
      const { plugin, decl } = declaredCollection(op, ctx.pluginId, input.collection);
      const schema = collectionDocSchema(decl);
      const problems: string[] = [];
      const upserts: CollectionDocInput[] = [];
      input.upserts.forEach((raw, i) => {
        const r = schema.safeParse(raw);
        if (!r.success) {
          for (const issue of r.error.issues.slice(0, 3))
            problems.push(`upserts.${i}.${issue.path.join(".")}: ${issue.message}`);
          return;
        }
        const bytes = utf8.encode(JSON.stringify(r.data)).length;
        if (bytes > decl.maxDocumentBytes)
          problems.push(
            `upserts.${i}: ${bytes} bytes, the collection allows ${decl.maxDocumentBytes} per document`,
          );
        upserts.push(r.data);
      });
      let profile: SearchProfile | undefined;
      if (input.profile !== undefined) {
        const parsed = searchProfile.safeParse(input.profile);
        if (!parsed.success)
          for (const issue of parsed.error.issues.slice(0, 5))
            problems.push(`profile.${issue.path.join(".")}: ${issue.message}`);
        else profile = parsed.data;
      }
      if (problems.length > 0)
        refuse(
          op,
          `collection "${input.collection}" refused the write: ${problems.slice(0, 10).join("; ")}`,
        );
      if (upserts.length === 0 && input.deletes.length === 0 && !input.replaceAll && !profile)
        refuse(op, "nothing to write: pass upserts, deletes, replaceAll or a profile");
      const data = encodeChangeFile({
        upserts,
        deletes: input.deletes,
        replaceAll: input.replaceAll,
        ...(profile ? { profile } : {}),
      });
      const changeId = crypto.randomUUID();
      const key = `${collectionPrefix(plugin.slug, input.collection)}/changes/${changeId}.bin`;
      await store().write(key, data);
      await tx.execute(sql`
        INSERT INTO collection_changes (id, plugin_id, collection, run_id, store_key, upserts, deletes, replace_all, bytes)
        VALUES (${changeId}::uuid, ${plugin.pluginId}::uuid, ${input.collection}, ${input.stageRunId ?? null}, ${key},
                ${upserts.length}, ${input.deletes.length}, ${input.replaceAll}, ${data.length})
      `);
      return ok({ changeId });
    },
  });
  const get = defineOperation({
    name: COLLECTION_OPS.get,
    readScope: "request",
    // Why plugin-only: see write.
    actorScope: ["plugin"],
    database: "cms_admin",
    input: z
      .object({
        collection: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
        id: z.string().min(1).max(200),
      })
      .strict(),
    output: z.object({ doc: z.unknown().nullable() }),
    handler: async (ctx, input, tx) => {
      const { plugin } = declaredCollection(COLLECTION_OPS.get, ctx.pluginId, input.collection);
      const rows = (await tx.execute(sql`
        SELECT release_key FROM collection_releases
        WHERE plugin_id = ${plugin.pluginId}::uuid AND collection = ${input.collection} AND state = 'ready'
        ORDER BY created_at DESC LIMIT 1
      `)) as unknown as { release_key: string }[];
      const releaseKey = rows[0]?.release_key;
      if (!releaseKey) return ok({ doc: null });
      const prefix = collectionPrefix(plugin.slug, input.collection);
      const s = store();
      const cache = new FileCache({ read: (f) => s.read(`${prefix}/${f}`) }, 64 * 1024 * 1024);
      const release = await openRelease(
        parseRelease(await s.read(`${prefix}/${releaseKey}`)),
        cache,
      );
      const found = await lookupDocs(release, [idTerm(input.id)]);
      const doc = found[0];
      return ok({ doc: doc ? { id: doc.id, lang: doc.lang, values: doc.values } : null });
    },
  });
  return [write, get] as unknown as OperationDefinition<unknown, unknown>[];
}

/** Registers the collection operations once. */
export function registerCollectionOps(
  registry: OperationRegistry,
  store: () => CollectionStore = () => collectionStoreFromEnv(STAGING_COLLECTION_STORE_ENV),
): void {
  for (const op of makeCollectionOps(store)) if (!registry.has(op.name)) registry.register(op);
}

const WRITING_ORIGINS: ReadonlySet<string> = new Set([
  "observer",
  "batch",
  "worker",
  "owner-panel",
  "approved",
  "system",
]);

/** `ctx.collections` of one invocation. */
export function makePluginCollections(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  invocation: PluginInvocation,
): PluginCollections {
  registerCollectionOps(infra.registry);
  const ctx = {
    actorId: plugin.pluginActorId,
    actorKind: "plugin" as const,
    pluginId: plugin.pluginId,
    requestId: `plugin-${plugin.slug}-collections`,
  };
  const run = async <T>(opName: string, input: unknown): Promise<T> => {
    const r = await execute(infra.registry, infra.adapter, ctx, opName, input);
    if (!r.ok) throw new Error("message" in r.error ? String(r.error.message) : r.error.kind);
    return r.value as T;
  };
  const assertWriting = (method: string): void => {
    if (WRITING_ORIGINS.has(invocation.origin)) return;
    throw new Error(
      invocation.origin === "chat"
        ? `ctx.collections.${method}: plugin "${plugin.slug}" cannot write its collections from a chat — a collection is derived from what the site publishes; change the pages or the plugin's settings, and the next Stage re-indexes`
        : `ctx.collections.${method}: plugin "${plugin.slug}" cannot write its collections from a ${invocation.origin} call`,
    );
  };
  const out: Record<string, PluginCollectionHandle> = {};
  for (const name of Object.keys(plugin.definition.collections ?? {})) {
    out[name] = Object.freeze({
      upsert: async (docs: readonly CollectionDocInput[]) => {
        assertWriting("upsert");
        for (let i = 0; i < docs.length; i += MAX_UPSERTS) {
          await run(COLLECTION_OPS.write, {
            collection: name,
            upserts: docs.slice(i, i + MAX_UPSERTS),
            deletes: [],
            ...(invocation.stageRunId ? { stageRunId: invocation.stageRunId } : {}),
          });
        }
      },
      delete: async (ids: readonly string[]) => {
        assertWriting("delete");
        for (let i = 0; i < ids.length; i += MAX_DELETES) {
          await run(COLLECTION_OPS.write, {
            collection: name,
            upserts: [],
            deletes: ids.slice(i, i + MAX_DELETES),
            ...(invocation.stageRunId ? { stageRunId: invocation.stageRunId } : {}),
          });
        }
      },
      get: async (id: string) =>
        (
          await run<{ doc: CollectionDocInput | null }>(COLLECTION_OPS.get, {
            collection: name,
            id,
          })
        ).doc,
      setProfile: async (profile: SearchProfileInput) => {
        assertWriting("setProfile");
        await run(COLLECTION_OPS.write, {
          collection: name,
          upserts: [],
          deletes: [],
          profile,
          ...(invocation.stageRunId ? { stageRunId: invocation.stageRunId } : {}),
        });
      },
    });
  }
  return Object.freeze(out);
}
