# Page output for plugins

Epic #1644, R1 (issue #1647). With the `page_output` grant, a plugin declares one observer operation. At every Stage, core reads the staged HTML exactly as Publish live ships it and hands the plugin the facts of the pages it has not seen in that form. A search index, a link checker or a sitemap of its own are then derived from what the site really publishes, not from drafts.

```ts
pageOutputObserver: {
  operation: "observe",
  // Optional: treat modules by how many pages show the same content.
  placementSteps: { thresholds: ["counting.full_max", "counting.reduced_max"], halfFrom: 11 },
},
```

## What an observer gets

`PageOutputObserverArgs`: `runId`, `pages` (facts, in batches of at most 200 pages and 768 KB), `publishedPageCount`, and on the last call `final: true` with `removed` (pages it saw before that this Stage no longer ships) and `placementChanges` (modules whose placement count changed).

`PageOutputFacts` per page:

- path, URL, language, title, short title, meta description, page type, properties, terms, breadcrumb;
- `noindex`, `notFoundPage`, `hasDeferredContent` (a withheld module or a baked plugin region: some visitors see other text), `truncated`;
- `modules`, each with its zone (`layout` chrome, `template` block or the page's own `page` placement), kind, content instance, `placementCount` (pages with the module) and `contentPlacementCount` (pages with the same content: the instance's pages, 1 for a page's own content);
- `texts`, one per visible run, each with its module, list entry, plugin region, source (`text`, an attribute, `literal`), heading level, section anchor, `inForm` and `inLink`;
- `links` with the path and target page id they resolve to.

A page carries at most 200,000 characters of text and 2,000 links (`truncated` says when it was cut), so one page always fits one call. Source: `packages/plugin-host/src/page-output-facts.ts` (extraction), `apps/static-generator/src/page-output.ts` (collection during the build).

## When a page comes again

Core records per plugin and page what it delivered (`plugin_page_observations`). A page comes again when one of these changes:

- its HTML;
- the plugin's settings for that page (`entityConfig.page`);
- the placement step of one of its modules, when the plugin declares `placementSteps`. The step is computed from `contentPlacementCount`, so a module reused with each page's own words never moves. With `halfFrom` a step also moves with the site's size alone (a block on 11 of 21 pages is past half, on 11 of 22 it is not), and the steps are part of what the plugin received for the page, so those pages come again although their facts did not change;
- the observer digest: the plugin's version and approved artifact, its configuration without `immediate` fields, and its module settings. A new digest sends every page again.

A page whose HTML changed but whose facts, settings and module steps did not is recorded without a call. Deliveries are pending until the Stage succeeds; a failed build discards them, so the next Stage sends those pages again (`page_output.discard_run`). A succeeded Stage's deliveries count in `collections.finish_stage`, together with its index plan, one Stage at a time in the order the builds started. A Stage that finishes after a newer Stage (its finish delayed past the newer one's) is superseded: the newer one compared against observations this one never committed, so it delivered this Stage's pages too, and this Stage records nothing; its index releases fail as superseded.

## What an observer may write

Only its collections and its private storage. A write to a public table is refused: visitors would see staged data before Publish live. Collection writes of an observer call belong to that Stage's index (`stageRunId`). See `plugin-collections.md`.
