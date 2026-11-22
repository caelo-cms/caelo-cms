# Plugin collections and collection operations

Epic #1644, R2 and R3 (issues #1648, #1649), with semantic search from R7 (#1650). A plugin with the `collections` grant declares document collections; core indexes them at every Stage, ships the index with Publish live, and answers visitors' `search`, `suggest` and `read` in the gateway without running plugin code.

## Declaring

```ts
collections: {
  pages: {
    description: "Every page that is a search result.",
    fields: {
      title: { kind: "text", prefix: true },
      sections: { kind: "passages", vector: true },
      url: { kind: "keyword" },
      page_type: { kind: "keyword", facet: true },
    },
    vectorModelConfig: "semantic.model", // a catalogModel leaf of `config`
    maxDocuments: 60_000,
    maxDocumentBytes: 400_000,
  },
},
collectionOperations: [
  { name: "search", kind: "search", collection: "pages", description: "…",
    returns: ["url", "title"], snippet: "sections", filters: ["page_type"], facets: ["page_type"],
    anchors: { collection: "anchors", target: "target", sources: "sources" } },
  { name: "suggest", kind: "suggest", collection: "pages", description: "…", returns: ["url", "title"] },
  { name: "read", kind: "read", collection: "pages", description: "…", by: "url", returns: ["title"], passages: "sections" },
],
```

Field kinds: `text` (optionally `prefix` for search as you type), `passages` (sections with anchor, heading and text; at most one with `vector`), `keyword` (filters, facets, exact lookup), `number`, `date`.

`anchors` adds the documents other collections' texts describe: a document of `anchors.collection` whose text matches names its target in the keyword `target`. Without `targetField` the target is a document id. With `targetField` (a keyword field of the searched collection, such as a page's canonical path) the target is that value, resolved when the visitor searches: the text counts for whatever document holds the value then. Name addresses this way when the target can appear after the text was written (a link to a page published later), because a page's facts are delivered again only when its own output changes.

## Writing

`ctx.collections.<name>`:

- `upsert(docs)` and `delete(ids)`;
- `replace(field, values, docs)`: removes every document whose keyword `field` holds one of `values`, then adds `docs`, as one change. A page's anchor texts are replaced whole this way. More than 1000 values take several change files; the documents ride on the last one, so no later removal takes one of them away.
- `setProfile(profile)`: the search profile (weights, boosts, synonyms, best bets, protected terms, typos, compounds, cross-language, semantic weight, start questions). It travels in the release and goes live with it.
- `get(id)` and `getMany(ids)`: documents as the newest staged index holds them. `getMany` also says `pending` when changes no index holds yet exist (other than this Stage's own; a failed Stage's discarded changes never will be held and do not count). A comparison against the index must then not skip a write. Keep change-detection state (digests) in the collection, next to what it describes, never in the plugin's own storage: a failed Stage discards its collection writes, and only state in the index is discarded with them.
- `query(operation, params, opts)`: one of the plugin's collection operations, run in the admin on a Stage's release (`runId`), the newest staged one or the live one, optionally with `explain` (fields, synonyms, typo fixes, compounds, anchor texts, meaning, pinned). For previews the AI shows and for Stage checks.

Writes are allowed from observers, batches, workers, the owner panel, approvals and the system. A chat cannot write a collection: a collection is derived from what the site publishes. Every write is a change file in the staging collection store plus a `collection_changes` row. Source: `packages/plugin-host/src/collections-host.ts`.

## From a Stage to visitors

1. **Plan.** After a successful Stage, `collections.plan_run` gives every active collection a release for the run. The release is carried over (no changes), pending, or failed (the plugin's observer failed, or its embedding model is missing; then the run's writes of that plugin are discarded and it records nothing of the run, so the next Stage delivers those pages again). A pending release builds on the newest ready release. Its members (`collection_release_changes`) are every change no ready release applied yet that the run wrote, that no Stage wrote, or that a Stage wrote whose plan recorded this collection (its index still building or failed). A change keeps the run that wrote it: a later plan builds the changes of an earlier release still being built in too, but never takes them away, so every release is built from exactly the members its plan chose, and the newest ready release always holds what any ready release applied. A Stage whose plan has not run keeps its writes (still running, or finished but before its plan discarded a failed observer's partial writes): its own plan or its discard decides them. A Stage plans before its audit starts and before its page output counts as delivered: a plugin's audit rule reads the index state, and a plan that fails leaves nothing recorded. A per-collection lock (`pg_advisory_xact_lock(1644, …)`) serialises that choice with `collections.index_done`, so an index completing in between cannot mark its changes applied after the plan chose the release before it.
2. **Index.** The `collection_index` reporting job (Cloud Run job `caelo-<env>-index`, in-process on self-hosted installs) folds the run's change files. It writes a delta on the previous release, or rebuilds when there is none, the schema changed, the protected terms changed, the embedding model changed, or a full replacement came. It reports each release ready or failed (`packages/admin-core/src/collections/index-job.ts`).
3. **Staging.** The projection publishes the pointed run's ready releases into `published_collections`. The staging gateway serves them from the staging store.
4. **Publish live.** It is refused while an index of the Stage is pending or failed. It copies the files the live store lacks, release file last, before the pointer moves (`collections/promote.ts`).
5. **Rollback.** It puts the restored build's releases back. A build whose index was cleaned up is refused with the reason.

`get_stage_status` reports every succeeded Stage's indexes: ready, still building, or failed with the reason.

## The engine

`packages/collection-index`: Snowball stemming for 16 languages, NFKC and diacritic folding, compound splitting against the vocabulary, typo tolerance (one edit under 8 letters, two above), BM25F with one IDF per query word, synonyms and prefix completions as their own groups, filters, facets, highlight ranges for snippets (never HTML), and deterministic vector search (binary candidates, int8 rescoring) fused with words by reciprocal rank (k = 60). Segments are immutable and content-addressed; a release is a list of segments with removed sets. The merge policy is at most 8 segments and 25 % removed. Embedding models: `docs/dev/embedding-models.md`.

Targets and measurements at 50,000 pages: `docs/dev/scale-gate.md` (collections section).

## The gateway

`GET /api/plugin/<slug>/<op>?release=<key>&q=…&lang=…` answers from the release the request names. Such an answer is `public, max-age=60, s-maxage=<cacheSeconds>`, so the CDN answers a repeated query. A request naming another release gets 409 with the current key. `/release` names the current key uncached; it is the warm-up call, and it starts loading the release's model in the background. No cookie is read or set.

Collection reads have their own in-memory budget: 10 per second per client and 100 per second per operation and instance. The executor is shared with the admin (`packages/plugin-host/src/collection-query.ts`), so the AI's preview answers exactly as visitors' searches do. Visitors' queries are kept out of the request logs (a Cloud Logging exclusion), and a read writes nothing to the database: no request-log row, whatever it answers (`docs/dev/gateway-hardening.md`).

## Stores and clean-up

`CAELO_COLLECTIONS_STAGING_STORE` and `CAELO_COLLECTIONS_LIVE_STORE` name each store (`gs://bucket[/prefix]` or `file:///dir`). Rights:

- the admin reads and writes both;
- the index job reads and creates in staging only;
- the live gateway reads live only;
- the staging gateway reads staging only.

AWS and Azure have no store yet (#749, #750); there a plugin's collections fail at every Stage, loudly.

A daily tick task (`core:collections-gc`) keeps the releases of each collection's last 10 Stages, of the Stages the last 20 Publish live runs released, both pointers, any release being built together with its base, and each collection's newest ready release (the base the next Stage builds on, however many failed Stages followed it). It deletes every other file of the collection in both stores, and change files once a ready release holds them and no release still being built has them as members. A file written in the last six hours is never deleted (`GC_GRACE_MS`): the keep set is read before the deletes, and a writer still in flight is in none of it yet — an index job writing new segments, a Publish live copying a release whose manifest lands last. File names are content-addressed and never rewritten, so a file's age is when it was written. Uninstalling a plugin deletes its files.
