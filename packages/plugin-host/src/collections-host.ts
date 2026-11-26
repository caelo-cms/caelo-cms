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
  readProfile,
  storeFromUrl,
} from "@caelo-cms/collection-index";
import {
  type AiChatTool,
  aiChatOperationManifest,
  type ChatToolHit,
  type ChatToolResult,
  type CollectionDocInput,
  type CollectionOperationManifest,
  type CollectionQueryOptions,
  type CollectionQueryResult,
  collectionOperationManifest,
  type PluginChatTools,
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
  aiChatToolParams,
  type OpenEntry,
  runCollectionOperation,
  wasmQueryEmbedder,
} from "./collection-query.js";
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

/**
 * The providers with no collection store yet, and the issue that adds one:
 * a plugin's collection write fails there with this gap, so the Stage
 * records the plugin's collections as failed instead of indexing anywhere
 * else (CLAUDE.md §2: no fallbacks).
 */
const PROVIDERS_WITHOUT_COLLECTION_STORE: Readonly<Record<string, string>> = {
  aws: "issue #749: an S3 store per environment",
  azure: "issue #750: a Blob Storage store per environment",
};

/** The store an env var names; a loud error naming the variable when it is unset. */
export function collectionStoreFromEnv(
  envVar: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): CollectionStore {
  const url = env[envVar];
  if (!url) {
    const gap = PROVIDERS_WITHOUT_COLLECTION_STORE[env.CAELO_PROVIDER ?? ""];
    throw new Error(
      gap
        ? `plugin collections have no store on provider "${env.CAELO_PROVIDER}" yet (${gap}); this plugin's collections fail at every Stage until it exists — deactivate the plugin at /settings/plugins to Publish live without them`
        : `${envVar} is not set: plugin collections need their store (Google Cloud: run \`cms-provision upgrade\`, which creates it; self-hosted: \`cms-provision up\` writes a file:// directory into the Compose file)`,
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
  /**
   * #1651 — documents whose keyword `field` holds one of `values` are
   * removed before this file's upserts apply (a page's anchor texts
   * replaced as one change). Absent in files written before it.
   */
  readonly deleteWhere?: readonly { readonly field: string; readonly values: readonly string[] }[];
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
  releaseOf: "collections.release_of",
  getMany: "collections.get_docs",
} as const;

/** Defines the collection operations. `store` resolves the staging store (env in production, a directory in tests). */
export function makeCollectionOps(
  store: () => CollectionStore,
): OperationDefinition<unknown, unknown>[] {
  const write = defineOperation({
    name: COLLECTION_OPS.write,
    pluginAccess: "handle",
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
        deleteWhere: z
          .array(
            z
              .object({
                field: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
                values: z.array(z.string().min(1).max(500)).min(1).max(MAX_DELETES),
              })
              .strict(),
          )
          .max(4)
          .default([]),
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
      for (const [i, w] of input.deleteWhere.entries()) {
        if (decl.fields[w.field]?.kind !== "keyword")
          problems.push(
            `deleteWhere.${i}.field: "${w.field}" is not a keyword field of collection "${input.collection}"`,
          );
      }
      if (problems.length > 0)
        refuse(
          op,
          `collection "${input.collection}" refused the write: ${problems.slice(0, 10).join("; ")}`,
        );
      if (
        upserts.length === 0 &&
        input.deletes.length === 0 &&
        input.deleteWhere.length === 0 &&
        !input.replaceAll &&
        !profile
      )
        refuse(op, "nothing to write: pass upserts, deletes, deleteWhere, replaceAll or a profile");
      const data = encodeChangeFile({
        upserts,
        deletes: input.deletes,
        replaceAll: input.replaceAll,
        ...(input.deleteWhere.length > 0 ? { deleteWhere: input.deleteWhere } : {}),
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
    pluginAccess: "handle",
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
  const releaseOf = defineOperation({
    name: COLLECTION_OPS.releaseOf,
    pluginAccess: "handle",
    readScope: "request",
    // Why plugin-only: a plugin reads which release of its own collections to query.
    actorScope: ["plugin"],
    database: "cms_admin",
    input: z
      .object({
        collections: z
          .array(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/))
          .min(1)
          .max(2),
        /** A Stage's run; absent: `at`. */
        runId: z.string().uuid().optional(),
        /** `staged`: the newest Stage with a ready index; `live`: what visitors search. */
        at: z.enum(["staged", "live"]).default("staged"),
      })
      .strict(),
    output: z.object({
      releases: z.array(
        z.object({
          collection: z.string(),
          state: z.enum(["pending", "ready", "failed", "none"]),
          releaseKey: z.string().nullable(),
          error: z.string().nullable(),
          runId: z.string().nullable(),
        }),
      ),
    }),
    handler: async (ctx, input, tx) => {
      const plugin = declaredCollection(
        COLLECTION_OPS.releaseOf,
        ctx.pluginId,
        input.collections[0] as string,
      ).plugin;
      for (const c of input.collections)
        declaredCollection(COLLECTION_OPS.releaseOf, ctx.pluginId, c);
      const out = [];
      for (const collection of input.collections) {
        const rows = (await tx.execute(
          input.runId
            ? sql`SELECT run_id::text AS run_id, state, release_key, error FROM collection_releases
                  WHERE plugin_id = ${plugin.pluginId}::uuid AND collection = ${collection} AND run_id = ${input.runId}::uuid`
            : input.at === "live"
              ? sql`SELECT c.run_id::text AS run_id, c.state, c.release_key, c.error FROM collection_releases c
                    JOIN projection_release_pointers p ON p.run_id = c.run_id AND p.environment = 'live'
                    WHERE c.plugin_id = ${plugin.pluginId}::uuid AND c.collection = ${collection}`
              : sql`SELECT run_id::text AS run_id, state, release_key, error FROM collection_releases
                    WHERE plugin_id = ${plugin.pluginId}::uuid AND collection = ${collection} AND state = 'ready'
                    ORDER BY created_at DESC LIMIT 1`,
        )) as unknown as {
          run_id: string;
          state: "pending" | "ready" | "failed";
          release_key: string | null;
          error: string | null;
        }[];
        const r = rows[0];
        out.push(
          r
            ? {
                collection,
                state: r.state,
                releaseKey: r.release_key,
                error: r.error,
                runId: r.run_id,
              }
            : { collection, state: "none" as const, releaseKey: null, error: null, runId: null },
        );
      }
      return ok({ releases: out });
    },
  });
  const getMany = defineOperation({
    name: COLLECTION_OPS.getMany,
    pluginAccess: "handle",
    readScope: "request",
    // Why plugin-only: see write.
    actorScope: ["plugin"],
    database: "cms_admin",
    input: z
      .object({
        collection: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
        ids: z.array(z.string().min(1).max(200)).min(1).max(1000),
        /** The Stage the caller writes for: its own changes are not "pending". */
        stageRunId: z.string().uuid().optional(),
      })
      .strict(),
    output: z.object({ docs: z.array(z.unknown()), pending: z.boolean() }),
    handler: async (ctx, input, tx) => {
      const { plugin } = declaredCollection(COLLECTION_OPS.getMany, ctx.pluginId, input.collection);
      // Changes no index holds yet, other than this Stage's own: the newest
      // index is then not what the plugin last wrote. A discarded change (a
      // failed Stage's) will never be held, so it does not count.
      const pendingRows = (await tx.execute(sql`
        SELECT 1 FROM collection_changes
        WHERE plugin_id = ${plugin.pluginId}::uuid AND collection = ${input.collection}
          AND applied_run_id IS NULL AND discarded_at IS NULL
          AND (${input.stageRunId ?? null}::uuid IS NULL OR run_id IS DISTINCT FROM ${input.stageRunId ?? null}::uuid)
        LIMIT 1
      `)) as unknown as unknown[];
      const rows = (await tx.execute(sql`
        SELECT release_key FROM collection_releases
        WHERE plugin_id = ${plugin.pluginId}::uuid AND collection = ${input.collection} AND state = 'ready'
        ORDER BY created_at DESC LIMIT 1
      `)) as unknown as { release_key: string }[];
      const releaseKey = rows[0]?.release_key;
      if (!releaseKey) return ok({ docs: [], pending: pendingRows.length > 0 });
      const entry = await openAdminRelease(
        store(),
        collectionPrefix(plugin.slug, input.collection),
        releaseKey,
      );
      const found = await lookupDocs(entry.release, input.ids.map(idTerm));
      return ok({
        docs: found.map((d) => ({ id: d.id, lang: d.lang, values: d.values })),
        pending: pendingRows.length > 0,
      });
    },
  });
  return [write, get, releaseOf, getMany] as unknown as OperationDefinition<unknown, unknown>[];
}

/** Open releases of the admin's queries (previews, audits), newest few kept. */
const adminReleases = new Map<string, Promise<OpenEntry>>();
const ADMIN_OPEN_RELEASES = 6;
let adminEmbedder: ReturnType<typeof wasmQueryEmbedder> | null = null;

async function openAdminRelease(
  store: CollectionStore,
  prefix: string,
  releaseKey: string,
): Promise<OpenEntry> {
  const id = `${store.describe}|${prefix}|${releaseKey}`;
  let entry = adminReleases.get(id);
  if (!entry) {
    entry = (async () => {
      const cache = new FileCache({ read: (f) => store.read(`${prefix}/${f}`) }, 64 * 1024 * 1024);
      const manifest = parseRelease(await store.read(`${prefix}/${releaseKey}`));
      const release = await openRelease(manifest, cache);
      const raw = await readProfile(manifest, cache);
      const parsed = raw === null ? null : searchProfile.safeParse(raw);
      return { release, profile: parsed?.success ? parsed.data : null };
    })();
    entry.catch(() => adminReleases.delete(id));
    adminReleases.set(id, entry);
    while (adminReleases.size > ADMIN_OPEN_RELEASES)
      adminReleases.delete(adminReleases.keys().next().value as string);
  }
  return entry;
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

/** The plugin's own actor, for the collection operations that run as it. */
function collectionActor(plugin: LoadedPlugin) {
  return {
    actorId: plugin.pluginActorId,
    actorKind: "plugin" as const,
    pluginId: plugin.pluginId,
    requestId: `plugin-${plugin.slug}-collections`,
  };
}

/**
 * Runs `op`, a declared operation of `owner`'s collections, on the release
 * `opts` names: as `owner` (the release lookup sees only its own rows), on
 * the staging store or, for `at: live`, the live one.
 */
async function queryCollectionOperation(
  owner: LoadedPlugin,
  infra: PluginHostInfra,
  op: CollectionOperationManifest,
  params: URLSearchParams,
  opts: CollectionQueryOptions,
): Promise<CollectionQueryResult> {
  registerCollectionOps(infra.registry);
  const anchorsName = op.kind === "search" ? op.anchors?.collection : undefined;
  const r = await execute(
    infra.registry,
    infra.adapter,
    collectionActor(owner),
    COLLECTION_OPS.releaseOf,
    {
      collections: anchorsName ? [op.collection, anchorsName] : [op.collection],
      ...(opts.runId ? { runId: opts.runId } : { at: opts.at ?? "staged" }),
    },
  );
  if (!r.ok) throw new Error("message" in r.error ? String(r.error.message) : r.error.kind);
  const resolved = r.value as {
    releases: {
      collection: string;
      state: CollectionQueryResult["state"];
      releaseKey: string | null;
      error: string | null;
      runId: string | null;
    }[];
  };
  const main = resolved.releases[0];
  if (!main || main.state !== "ready" || !main.releaseKey)
    return { state: main?.state ?? "none", error: main?.error ?? null, status: 503, body: null };
  // The live store when the live release is asked for; the staging one otherwise.
  const store = collectionStoreFromEnv(
    opts.at === "live" && !opts.runId ? LIVE_COLLECTION_STORE_ENV : STAGING_COLLECTION_STORE_ENV,
  );
  const entry = await openAdminRelease(
    store,
    collectionPrefix(owner.slug, op.collection),
    main.releaseKey,
  );
  const a = resolved.releases[1];
  const anchors =
    anchorsName && a?.state === "ready" && a.releaseKey
      ? await openAdminRelease(store, collectionPrefix(owner.slug, anchorsName), a.releaseKey)
      : null;
  adminEmbedder ??= wasmQueryEmbedder();
  const answer = await runCollectionOperation(op, entry, main.releaseKey, params, {
    embedQuery: adminEmbedder,
    anchors,
    explain: opts.explain === true,
  });
  return { state: "ready", error: null, status: answer.status, body: answer.body };
}

const plainText = (v: unknown): string =>
  typeof v === "string"
    ? v
    : v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string"
      ? (v as { text: string }).text
      : "";

/** The pages one tool answer names, as the gateway numbers them for the visitor. */
function chatToolHits(op: CollectionOperationManifest, body: unknown): ChatToolHit[] {
  const b = (body ?? {}) as { hits?: unknown[]; documents?: unknown[] };
  const rows = ((op.kind === "search" ? b.hits : b.documents) ?? []) as Record<string, unknown>[];
  return rows.map((h) => {
    const anchor = (h.snippet as { anchor?: unknown } | null | undefined)?.anchor;
    return {
      id: String(h.id ?? ""),
      url: plainText(h.url),
      title: plainText(h.title),
      anchor: typeof anchor === "string" && anchor !== "" ? anchor : null,
    };
  });
}

/**
 * `ctx.chatTools` (#1655): the tools a plugin's own `ai-chat` operations
 * declare, run as the gateway runs them for a visitor (the same parameters,
 * the same executor), here on a Stage's, the newest staged or the live
 * release. Only a declared tool of the named conversation runs, as the
 * plugin that owns the collection, and only while that plugin is active:
 * the Owner approved exactly these tools with the conversation, so a
 * site assistant's audit and previews reach nothing a visitor's turn could
 * not.
 */
export function makePluginChatTools(plugin: LoadedPlugin, infra: PluginHostInfra): PluginChatTools {
  const conversations = (plugin.definition.aiChatOperations ?? []).map((o) =>
    aiChatOperationManifest.parse(o),
  );
  return Object.freeze({
    run: async (
      conversation: string,
      tool: AiChatTool,
      input: Readonly<Record<string, string>>,
      opts: { readonly lang: string; readonly runId?: string; readonly at?: "staged" | "live" },
    ): Promise<ChatToolResult> => {
      const conv = conversations.find((c) => c.name === conversation);
      if (!conv)
        throw new Error(
          `ctx.chatTools.run: plugin "${plugin.slug}" declares no conversation "${conversation}"`,
        );
      if (!conv.tools.some((t) => t.plugin === tool.plugin && t.operation === tool.operation))
        throw new Error(
          `ctx.chatTools.run: ${tool.plugin}/${tool.operation} is not a tool of "${conversation}": only the tools a conversation declares run`,
        );
      const owner = tool.plugin === plugin.slug ? plugin : loadedPlugins.bySlug(tool.plugin);
      if (!owner || isPluginDisabled(owner.slug))
        return { state: "none", error: `plugin "${tool.plugin}" is not active`, hits: [] };
      const op = (owner.definition.collectionOperations ?? [])
        .map((o) => collectionOperationManifest.parse(o))
        .find((o) => o.name === tool.operation);
      if (!op || (op.kind !== "search" && op.kind !== "read"))
        return {
          state: "none",
          error: `${tool.plugin}/${tool.operation} is no search or read operation`,
          hits: [],
        };
      const r = await queryCollectionOperation(
        owner,
        infra,
        op,
        aiChatToolParams(op, input, opts.lang),
        opts.runId ? { runId: opts.runId } : { at: opts.at ?? "staged" },
      );
      if (r.state !== "ready") return { state: r.state, error: r.error, hits: [] };
      if (r.status !== 200) {
        const kind = (r.body as { error?: { kind?: unknown } } | null)?.error?.kind;
        return {
          state: "failed",
          error: typeof kind === "string" ? kind : `HTTP ${r.status}`,
          hits: [],
        };
      }
      return { state: "ready", error: null, hits: chatToolHits(op, r.body) };
    },
  });
}

/** `ctx.collections` of one invocation. */
export function makePluginCollections(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  invocation: PluginInvocation,
): PluginCollections {
  registerCollectionOps(infra.registry);
  const ctx = collectionActor(plugin);
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
      replace: async (
        field: string,
        values: readonly string[],
        docs: readonly CollectionDocInput[],
      ) => {
        assertWriting("replace");
        // Every removal first, then the documents: change files apply in
        // order, and a change removes before it adds. The documents ride on
        // the LAST removal chunk, so no later removal can take one of them
        // away (and up to 1000 values stay one change).
        for (let i = 0; i < values.length; i += MAX_DELETES) {
          const last = i + MAX_DELETES >= values.length;
          await run(COLLECTION_OPS.write, {
            collection: name,
            upserts: last ? docs.slice(0, MAX_UPSERTS) : [],
            deletes: [],
            deleteWhere: [{ field, values: values.slice(i, i + MAX_DELETES) }],
            ...(invocation.stageRunId ? { stageRunId: invocation.stageRunId } : {}),
          });
        }
        for (let i = values.length === 0 ? 0 : MAX_UPSERTS; i < docs.length; i += MAX_UPSERTS) {
          await run(COLLECTION_OPS.write, {
            collection: name,
            upserts: docs.slice(i, i + MAX_UPSERTS),
            deletes: [],
            ...(invocation.stageRunId ? { stageRunId: invocation.stageRunId } : {}),
          });
        }
      },
      query: async (
        operation: string,
        params: Readonly<Record<string, string | readonly string[]>>,
        opts: CollectionQueryOptions = {},
      ): Promise<CollectionQueryResult> => {
        const op = (plugin.definition.collectionOperations ?? [])
          .map((o) => collectionOperationManifest.parse(o))
          .find((o) => o.name === operation && o.collection === name);
        if (!op)
          throw new Error(
            `ctx.collections.${name}.query: plugin "${plugin.slug}" declares no collection operation "${operation}" on "${name}"`,
          );
        const search = new URLSearchParams();
        for (const [k, v] of Object.entries(params))
          for (const one of Array.isArray(v) ? v : [v as string]) search.append(k, one);
        return queryCollectionOperation(plugin, infra, op, search, opts);
      },
      getMany: async (ids: readonly string[]) => {
        const docs = new Map<string, CollectionDocInput>();
        let pending = false;
        for (let i = 0; i < ids.length; i += 1000) {
          const r = await run<{ docs: CollectionDocInput[]; pending: boolean }>(
            COLLECTION_OPS.getMany,
            {
              collection: name,
              ids: ids.slice(i, i + 1000),
              ...(invocation.stageRunId ? { stageRunId: invocation.stageRunId } : {}),
            },
          );
          for (const d of r.docs) docs.set(d.id, d);
          pending ||= r.pending;
        }
        return { docs, pending };
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
