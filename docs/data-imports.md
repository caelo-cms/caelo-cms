# Data imports

One way in for every kind of data from another system: comments, rating totals, redirects, and whatever a plugin declares next. Caelo has no code for WordPress, Disqus or any other source. The AI is the adapter: it reads the old system's export, converts it into the target shape of a kind, and hands the file to Caelo. Caelo knows each kind's shape, checks every row, resolves pages and parents, keeps imports idempotent, reports, and decides when the rows reach visitors.

The rows never pass through the model. A local MCP agent converts the source with a script and uploads the file from disk (`caelo_upload_data`); an agent that cannot read the operator's disk asks for an upload link (`request_data_upload`). Inline rows are for short pasted lists only (at most 200 per call). The model sees the report: counts and a few examples per problem.

## Kinds

A kind is the target shape of one kind of data. Core declares its own (`packages/admin-core/src/data-imports/kinds-redirects.ts`); a plugin declares its kinds in `imports` of its definition (`packages/plugin-sdk/src/imports.ts`):

```ts
imports: [
  {
    kind: "comments",
    label: "Comments",
    description: "Approved comments of another site, each on the page it belongs to.",
    sources: "WordPress: Tools -> Export, /wp-json/wp/v2/comments, or wp_comments.",
    release: "stage",
    parents: true,
    fields: {
      page: { type: "pageRef" },
      authorName: { type: "string", maxLength: 256 },
      content: { type: "text", maxLength: 50_000 },
      submittedAt: { type: "datetime" },
    },
    apply: "apply_comment_import",
    remove: "remove_comment_import",
  },
],
```

- Field types (`packages/shared/src/data-import/fields.ts`): `string`, `text`, `int`, `number`, `bool`, `datetime` (ISO 8601 with a zone), `enum`, `pageRef` (at most one per kind), `path`, `url`. Every value may arrive as a string; a value that does not read cleanly is a problem of its row, never a default. Empty means absent.
- `sourceKey` (the row's stable id in the old system) and `parentKey` (on kinds with `parents`) belong to every kind; a kind cannot declare them.
- `release`: `stage` lets the import framework decide when rows reach visitors (below); `target` means the kind writes into storage with its own drafts (redirects).
- `apply` (optional): core hands each batch of checked rows to this operation before it keeps them. It may refuse single rows (`{ refused: [{ rowId, detail }] }`) and may store them in the plugin's storage too. `remove` takes stored rows away again; an `apply` that stores declares it.
- Core always keeps the rows (`data_import_items`). A plugin reads its kinds' rows through `ctx.imports.rows(kind)`, as the public database its call writes shows them: a staging run sees what the Stage shipped, a build's render what the build carries, every other call what Publish live shipped. Drafts never reach plugin code.
- A plugin with `imports` needs the `chat_runner_tools` grant (each kind is an AI tool). Two active plugins cannot declare one kind name. Runtime-installed plugins cannot declare `imports` yet (`EXTERNAL_UNAVAILABLE_DECLARATIONS`).

Adding `imports` to a plugin changes its manifest: the Owner approves the new release as for any declaration change (`manifest-changes.ts` labels it "Data it can import from another system").

## One import call

`runDataImport` (`packages/admin-core/src/data-imports/run.ts`):

1. Read the rows: inline, or from uploads (CSV with a header row of field names, `,` `;` or tab; JSON Lines; a JSON array; UTF-8). `packages/shared/src/data-import/formats.ts` parses them; a row it cannot read is a problem, a file it cannot trust is refused.
2. A column the kind does not take refuses the whole call. That is how an e-mail or IP address column stays out of Caelo.
3. Check every row against the kind's fields; a `sourceKey` that appears twice is a problem.
4. `data_imports.lookup`: what earlier imports hold (one active row per owner, kind and `sourceKey`), and which pages the `pageRef`s name. A reference is a page id, a path, or an old URL; a path no page has may be an old address a redirect (live or pending) or a site import knows.
5. Parents: in the same input, or held by an earlier import. A missing parent, a parent with a problem, and a loop are problems.
6. With problems and without `skipInvalid`, or on a `dryRun`: report, write nothing. Otherwise `data_imports.open`, the kind writes its rows parents first, `data_imports.record` keeps them and the report.

Row ids are UUID v5 of the import and the `sourceKey` (`ids.ts`): a retried call writes the same target rows again instead of new ones. A later call with the same keys leaves rows another import holds alone (`unchanged`); `mode: "update"` overwrites rows of the import it names (`importId`). An import a Stage has shipped takes no more rows.

Uploads that an import used without problems are deleted after it; every upload goes after 7 days (`core:data-upload-gc`).

## When imported rows reach visitors

Kinds with release `stage` follow the same path as every other change: nothing an import writes reaches the live site before a human's Publish live (CLAUDE.md §2).

| State | Meaning |
|---|---|
| draft | Written; editors see it, no environment does. |
| waiting-for-build | The Stage that ships its chat merged it (`mergeChatImports`, in `chat.merge_draft_to_main` and `chat.merge_to_main`); an import made outside a chat is taken by the next build. |
| staged | A build stamped it (`stampImportsForRun`, in `deploy.start_trigger`, either environment), and staging's release pointer names that run or a later one. |
| live | The live release pointer names that run or a later one. |
| undo-pending / undone | The undo is a change of its own: it ships with the Stage of its chat and Publish live. |

The rule (`importShownSql`, `packages/plugin-host/src/import-rows.ts`): an environment shows an import while the run its release pointer names started at or after `staged_since`, and before `undo_staged_since`. A rollback only moves the pointer, so it takes the imports of the rolled-back release back with it.

Comments are core rows the projection publishes. `comment_archive.data_import_id` marks imported ones; the projection sends each to the public databases whose pointer shows its import (`commentShownIn`, `packages/migrations/src/public-projection.ts`), and a trigger on `projection_release_pointers` queues the comments of every import a pointer move changed. The bake reads the same rule: a build renders with `importView: "build"` (what the build carries), a plugin-data build with `importView: "live"` (`build-services.ts`); core operations read it as `ctx.renderImportView`. An imported comment's `archived_at` is its original date, so it sits in the thread where it was.

Undo (`undoDataImport`): an import no build carried yet is removed now (the kind's `remove`, then its rows); one that shipped keeps its rows until the undo ships, its keys free for a new import at once. Kinds with release `target` always remove through their own storage (redirects: pending removals).

## Storage and operations

Migration `0950_data_imports.sql`:

- `data_uploads`: files handed over, in the private media store under `data-uploads/`. `awaiting` is a slot an operator fills.
- `data_imports`: one import: kind, source, chat, report, release stamps.
- `data_import_items`: its rows (values, page, parent, digest, what the kind called the stored row).
- `comment_archive.data_import_id`.

Operations (`packages/admin-core/src/ops/data_imports.ts`, `data_uploads.ts`): `data_imports.lookup`, `.open`, `.record`, `.list`, `.get`, `.item_refs`, `.mark_undone`, `.plugin_rows` (the plugin host's, for `ctx.imports`); `data_uploads.create_slot`, `.record`, `.get`, `.forget`; `comment_archive.import_many` and `.remove_import` (the comments plugin's apply and remove).

## Tools and pages

- `import_<kind>`: one per kind that can be imported now, made from its declaration (`data-import-tools.ts`), so its schema names the exact fields. The registry reads them per call (`ToolRegistry.provide`); a kind's tool is absent while its plugin is not active.
- `list_data_imports`, `get_data_import`, `undo_data_import`, `request_data_upload`.
- MCP: `caelo_upload_data` (stdio Power shim only: reads the file, posts it to `/api/mcp/data-uploads`).
- Settings → Data imports (`/settings/data-imports`): imports, Undo, a file upload whose id goes to the AI. `/settings/data-imports/upload/<id>` is the page an agent's link opens.

Report examples quote the source data and reach the AI as untrusted data (`untrustedToolResult`).

## Kinds today

| Kind | Owner | Release | Where the rows go |
|---|---|---|---|
| `comments` | comments plugin | stage | `comment_archive`, approved, dated, threaded |
| `rating_totals` | ratings plugin | stage | core keeps them; `_refresh` adds them to the votes per public database |
| `redirects` | core | target | pending redirect changes (`redirects.create_many`), Staged |

## Tests

`packages/shared/src/data-import/*.test.ts` (fields, formats, report) and `packages/admin-core/src/__tests__/data-imports.integration.test.ts` (pipeline, release, rollback, undo, a chat's Stage, redirects, `ctx.imports`).
