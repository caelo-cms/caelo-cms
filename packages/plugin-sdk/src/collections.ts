// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin collections (epic #1644, R2, issue #1648): the fifth kind of plugin
 * data, beside the four table kinds.
 *
 * A collection is a set of documents in private object storage, indexed for
 * full-text, prefix and vector search, and bound to a release: it is frozen
 * with the Stage and goes live with Publish live. A plugin writes it from
 * its admin code (operations, observers, workers) and from its batch jobs;
 * visitors reach it only through the declared `search`, `suggest` and
 * `read` operations, which core executes in the gateway.
 *
 * Writes are not visible at once: they are changes for the next Stage's
 * index, which the `collection_index` job applies.
 */

import { z } from "zod";
import type { SearchProfileInput } from "./collection-operations.js";
import type { PluginConfigSchema } from "./config.js";

const fieldName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, "must be snake_case");

/** One declared field (see the engine's `FieldSpec`). */
export const collectionFieldSpec = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), prefix: z.boolean().optional() }).strict(),
  z
    .object({
      kind: z.literal("passages"),
      prefix: z.boolean().optional(),
      vector: z.boolean().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("keyword"), facet: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("number") }).strict(),
  z.object({ kind: z.literal("date") }).strict(),
]);

/** One collection's declaration. */
export const pluginCollectionManifest = z
  .object({
    description: z.string().min(1).max(600),
    fields: z.record(fieldName, collectionFieldSpec),
    /** Config leaves that drive the vector index: a `catalogModel` leaf, null when semantic search is off. */
    vectorModelConfig: z.string().min(1).max(200).optional(),
    /** Most documents; a write past it is refused. */
    maxDocuments: z.number().int().min(1).max(500_000),
    /** Largest document, as JSON. */
    maxDocumentBytes: z
      .number()
      .int()
      .min(256)
      .max(512 * 1024),
  })
  .strict();
export type PluginCollectionManifest = z.infer<typeof pluginCollectionManifest>;

/** At most this many collections per plugin. */
export const MAX_COLLECTIONS = 4;

/** Collection names, keyed in the manifest. */
export const collectionName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, "must be snake_case, at most 40 characters");

/** One section of a `passages` field. */
export interface CollectionPassage {
  readonly anchor: string;
  readonly heading: string;
  readonly text: string;
}

/** A document a plugin writes. */
export interface CollectionDocInput {
  readonly id: string;
  readonly lang: string;
  readonly values: Readonly<
    Record<string, string | readonly string[] | number | readonly CollectionPassage[] | null>
  >;
}

/** The write handle of one collection, in `ctx.collections`. */
export interface PluginCollectionHandle {
  /** Adds or replaces documents for the next index. At most 500 per call. */
  upsert(docs: readonly CollectionDocInput[]): Promise<void>;
  /** Removes documents by id for the next index. At most 1000 per call. */
  delete(ids: readonly string[]): Promise<void>;
  /**
   * Removes every document whose keyword `field` holds one of `values`, then
   * adds `docs`, as one change: what one source said is replaced whole
   * (a page's anchor texts). `docs` may be empty (a removal by field).
   */
  replace(field: string, values: readonly string[], docs: readonly CollectionDocInput[]): Promise<void>;
  /** A document as the newest staged index holds it, or null. */
  get(id: string): Promise<CollectionDocInput | null>;
  /**
   * Many documents as the newest staged index holds them (absent ids are
   * missing from the map). `pending` is true when changes no index holds yet
   * exist (other than this Stage's own): the index is then not what the
   * plugin last wrote, and a comparison against it must not skip a write.
   */
  getMany(ids: readonly string[]): Promise<{
    readonly docs: ReadonlyMap<string, CollectionDocInput>;
    readonly pending: boolean;
  }>;
  /**
   * Runs one of the plugin's declared collection operations on this
   * collection in the admin, exactly as the gateway answers visitors: for a
   * preview the AI shows the operator, or a Stage check. `state` is the
   * release's (`pending` while its index is built, `none` before the first);
   * `body` is the gateway's answer when it is `ready`.
   */
  query(
    operation: string,
    params: Readonly<Record<string, string | readonly string[]>>,
    opts?: CollectionQueryOptions,
  ): Promise<CollectionQueryResult>;
  /**
   * Sets the collection's search profile for the next index: what the
   * operator tuned (weights, synonyms, best bets, protected terms, …), as the
   * gateway's `search` and `suggest` read it. Validated against
   * `searchProfile`; the release keeps the last one set.
   */
  setProfile(profile: SearchProfileInput): Promise<void>;
}

/** Which release a {@link PluginCollectionHandle.query} reads. */
export interface CollectionQueryOptions {
  /** A Stage's release (its run id); otherwise `at`. */
  readonly runId?: string;
  /** `staged` (default): the newest Stage with a ready index; `live`: what visitors search. */
  readonly at?: "staged" | "live";
  /** Each hit says where it comes from (fields, synonyms, typos, anchor texts, meaning, pinned). */
  readonly explain?: boolean;
}

/** What a {@link PluginCollectionHandle.query} answers. */
export interface CollectionQueryResult {
  readonly state: "pending" | "ready" | "failed" | "none";
  readonly error: string | null;
  readonly status: number;
  readonly body: unknown;
}

/** `ctx.collections`: one handle per declared collection. */
export type PluginCollections = Readonly<Record<string, PluginCollectionHandle>>;

type Issue = (path: readonly (string | number)[], message: string) => void;

/** Lints collection declarations against the engine's limits and the plugin's config. */
export function checkCollections(
  collections: Readonly<Record<string, PluginCollectionManifest>> | undefined,
  config: PluginConfigSchema | undefined,
  issue: Issue,
): void {
  const entries = Object.entries(collections ?? {});
  if (entries.length > MAX_COLLECTIONS)
    issue(["collections"], `at most ${MAX_COLLECTIONS} collections`);
  for (const [name, c] of entries) {
    if (!collectionName.safeParse(name).success)
      issue(["collections", name], "collection names are snake_case, at most 40 characters");
    let slots = 0;
    let vectors = 0;
    for (const [field, spec] of Object.entries(c.fields)) {
      if (["id", "lang", "key"].includes(field))
        issue(["collections", name, "fields", field], `"${field}" is the document's own attribute`);
      if (spec.kind === "text") slots += 1;
      if (spec.kind === "passages") {
        slots += 2;
        if (spec.vector) vectors++;
      }
    }
    if (slots === 0) issue(["collections", name, "fields"], "at least one text or passages field");
    if (slots > 14)
      issue(
        ["collections", name, "fields"],
        `at most 14 searchable slots (a passages field takes two), got ${slots}`,
      );
    if (vectors > 1)
      issue(["collections", name, "fields"], "at most one passages field with vectors");
    if (c.vectorModelConfig !== undefined) {
      if (vectors === 0)
        issue(
          ["collections", name, "vectorModelConfig"],
          "names a model, but no passages field has `vector: true`",
        );
      const leaf = leafAt(config, c.vectorModelConfig);
      if (leaf?.type !== "catalogModel")
        issue(
          ["collections", name, "vectorModelConfig"],
          `"${c.vectorModelConfig}" must name a catalogModel leaf of \`config\``,
        );
    } else if (vectors > 0)
      issue(
        ["collections", name, "vectorModelConfig"],
        "a vector field needs `vectorModelConfig`, the config leaf that picks the model",
      );
  }
}

/** The config leaf at a dotted path, or undefined. */
export function leafAt(
  config: PluginConfigSchema | undefined,
  path: string,
): Exclude<PluginConfigSchema[string], { type: "group" }> | undefined {
  let fields: PluginConfigSchema | undefined = config;
  const parts = path.split(".");
  for (let i = 0; i < parts.length; i++) {
    const f = fields?.[parts[i] as string];
    if (!f) return undefined;
    if (i === parts.length - 1) return f.type === "group" ? undefined : f;
    if (f.type !== "group") return undefined;
    fields = f.fields;
  }
  return undefined;
}
