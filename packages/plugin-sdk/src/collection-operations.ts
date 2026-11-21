// SPDX-License-Identifier: MPL-2.0

/**
 * Declarative visitor operations over collections (epic #1644, R3, issue
 * #1649): `search`, `suggest` and `read`.
 *
 * They have no handler. Core executes them in the gateway with the
 * collection engine, so no plugin code runs on the public side (#1340).
 * Answers are cacheable GET requests: the release id is part of the URL and
 * no cookie is read or set, so the CDN serves a repeated query without
 * waking the gateway.
 *
 * What the operator tunes (slot weights, synonyms, best bets, protected
 * terms, typo tolerance, semantic search, curated suggestions) is not in
 * the manifest: it is the collection's search profile, which the plugin
 * writes at every Stage from its configuration and lists
 * (`ctx.collections.<name>.setProfile`). The profile is a file of the
 * collection's release, so it is frozen with the Stage and goes live with
 * Publish live like the index it tunes.
 */

import { z } from "zod";

const opName = z.string().regex(/^[a-z_][a-z0-9_]{0,119}$/);
const fieldName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);

const rateLimit = z
  .object({
    max: z.number().int().min(1).max(10_000),
    windowSeconds: z.number().int().min(1).max(86_400),
  })
  .strict();

/** `search`: ranked documents with snippets, filters and facets. */
export const searchOperationManifest = z
  .object({
    name: opName,
    kind: z.literal("search"),
    collection: z.string().min(1).max(40),
    description: z.string().min(1).max(600),
    /** Stored fields every hit returns (e.g. url, title). */
    returns: z.array(fieldName).min(1).max(16),
    /** The passages field snippets are cut from. */
    snippet: fieldName.optional(),
    /** Keyword fields a visitor may filter on. */
    filters: z.array(fieldName).max(8).default([]),
    /** Number or date fields a visitor may filter by range. */
    ranges: z.array(fieldName).max(4).default([]),
    /** Facet fields counted for every answer. */
    facets: z.array(fieldName).max(4).default([]),
    /** `visitor`: only documents in the visitor's language, unless the profile allows cross-language hits. */
    language: z.enum(["visitor", "any"]).default("visitor"),
    maxQueryChars: z.number().int().min(10).max(200).default(120),
    maxResults: z.number().int().min(1).max(50).default(20),
    /** CDN lifetime of one answer; the release id in the URL makes a new Stage a new URL. */
    cacheSeconds: z.number().int().min(60).max(86_400).default(3600),
    rateLimit: rateLimit.optional(),
  })
  .strict();

/** `suggest`: completions while typing, and the curated list for an empty field. */
export const suggestOperationManifest = z
  .object({
    name: opName,
    kind: z.literal("suggest"),
    collection: z.string().min(1).max(40),
    description: z.string().min(1).max(600),
    /** Stored fields a document suggestion returns (e.g. url, title). */
    returns: z.array(fieldName).min(1).max(8),
    maxResults: z.number().int().min(1).max(10).default(8),
    cacheSeconds: z.number().int().min(60).max(86_400).default(3600),
    rateLimit: rateLimit.optional(),
  })
  .strict();

/** `read`: whole documents or one passage, by id or by a keyword value. */
export const readOperationManifest = z
  .object({
    name: opName,
    kind: z.literal("read"),
    collection: z.string().min(1).max(40),
    description: z.string().min(1).max(600),
    /** `id`, or a keyword field (e.g. `url`). */
    by: z.union([z.literal("id"), fieldName]),
    returns: z.array(fieldName).min(1).max(16),
    /** The passages field a `passage` parameter selects from. */
    passages: fieldName.optional(),
    maxDocuments: z.number().int().min(1).max(5).default(1),
    cacheSeconds: z.number().int().min(60).max(86_400).default(3600),
    rateLimit: rateLimit.optional(),
  })
  .strict();

/** One declared collection operation. */
export const collectionOperationManifest = z.discriminatedUnion("kind", [
  searchOperationManifest,
  suggestOperationManifest,
  readOperationManifest,
]);
export type CollectionOperationManifest = z.infer<typeof collectionOperationManifest>;
export type CollectionOperationInput = z.input<typeof collectionOperationManifest>;

/** Most collection operations per plugin. */
export const MAX_COLLECTION_OPERATIONS = 8;

/**
 * The search profile of a collection: what the operator tunes, as the
 * gateway reads it. The plugin derives it from its config and lists;
 * core validates it before the index job accepts it.
 */
export const searchProfile = z
  .object({
    /** Weight per searchable slot ("title", "sections.heading", …). */
    weights: z.record(z.string().min(1).max(80), z.number().min(0).max(20)),
    /** Multipliers by keyword value, e.g. page_type product × 1.5. */
    boosts: z
      .array(
        z
          .object({
            field: fieldName,
            values: z.record(z.string().min(1).max(200), z.number().min(0).max(10)),
          })
          .strict(),
      )
      .max(4)
      .default([]),
    /** Per language: folded word → the words it also stands for. */
    synonyms: z
      .record(
        z.string().min(2).max(16),
        z.record(z.string().min(1).max(80), z.array(z.string().min(1).max(80)).max(10)),
      )
      .default({}),
    /** Per language: a normalised query → document ids pinned on top, in order. */
    bestBets: z
      .record(
        z.string().min(2).max(16),
        z
          .array(
            z
              .object({
                query: z.string().min(1).max(120),
                ids: z.array(z.string().min(1).max(200)).min(1).max(5),
              })
              .strict(),
          )
          .max(500),
      )
      .default({}),
    /** Folded words never stemmed (brand and product names). */
    protectedTerms: z.array(z.string().min(1).max(80)).max(2000).default([]),
    typos: z.boolean(),
    compounds: z.boolean(),
    prefix: z.boolean(),
    crossLanguage: z.boolean(),
    semantic: z
      .object({ weight: z.number().min(0).max(5), minSimilarity: z.number().min(-1).max(1) })
      .strict()
      .nullable(),
    /** Per language: suggestions shown before or while typing. */
    suggestions: z
      .record(
        z.string().min(2).max(16),
        z
          .array(
            z
              .object({
                text: z.string().min(1).max(120),
                source: z.enum(["curated", "content", "popular"]),
              })
              .strict(),
          )
          .max(500),
      )
      .default({}),
  })
  .strict();
export type SearchProfile = z.infer<typeof searchProfile>;
export type SearchProfileInput = z.input<typeof searchProfile>;

type Issue = (path: readonly (string | number)[], message: string) => void;

/** Lints collection operations against the plugin's collections and other operation names. */
export function checkCollectionOperations(
  ops: readonly CollectionOperationManifest[] | undefined,
  collections:
    | Readonly<
        Record<
          string,
          {
            readonly fields: Readonly<
              Record<string, { readonly kind: string; readonly prefix?: boolean }>
            >;
          }
        >
      >
    | undefined,
  otherNames: readonly string[],
  issue: Issue,
): void {
  const seen = new Set(otherNames);
  for (const [i, op] of (ops ?? []).entries()) {
    const path = ["collectionOperations", i];
    if (seen.has(op.name))
      issue(
        [...path, "name"],
        `"${op.name}" is already an operation name: collection operations have no handler and need a name of their own`,
      );
    seen.add(op.name);
    const c = collections?.[op.collection];
    if (!c) {
      issue([...path, "collection"], `"${op.collection}" is not a declared collection`);
      continue;
    }
    const kindOf = (f: string) => c.fields[f]?.kind;
    for (const f of op.returns)
      if (!kindOf(f))
        issue([...path, "returns"], `"${f}" is not a field of collection "${op.collection}"`);
    if (op.kind === "search") {
      if (op.snippet && kindOf(op.snippet) !== "passages")
        issue([...path, "snippet"], `"${op.snippet}" must be a passages field`);
      for (const f of op.filters)
        if (kindOf(f) !== "keyword") issue([...path, "filters"], `"${f}" must be a keyword field`);
      for (const f of op.ranges)
        if (kindOf(f) !== "number" && kindOf(f) !== "date")
          issue([...path, "ranges"], `"${f}" must be a number or date field`);
      for (const f of op.facets)
        if (kindOf(f) !== "keyword") issue([...path, "facets"], `"${f}" must be a keyword field`);
    }
    if (op.kind === "suggest" && !Object.values(c.fields).some((f) => f.prefix)) {
      issue(
        [...path, "collection"],
        `collection "${op.collection}" has no field with \`prefix: true\` to complete from`,
      );
    }
    if (op.kind === "read") {
      if (op.by !== "id" && kindOf(op.by) !== "keyword")
        issue([...path, "by"], `"${op.by}" must be "id" or a keyword field`);
      if (op.passages && kindOf(op.passages) !== "passages")
        issue([...path, "passages"], `"${op.passages}" must be a passages field`);
    }
  }
}
