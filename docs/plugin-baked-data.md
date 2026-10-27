# Plugin data in the static HTML (plugin-data builds)

Issue #1155, CMS_REQUIREMENTS §6.1 / §6.2.

A plugin that shows visitor data on pages (comments, ratings, a guestbook) bakes that data into the static HTML with `staticRender`, and its Web Component fetches what came after the bake (the delta feed, `since` = the bake's `data-baked-at`). Nothing reaches production except a human Publish live (#1154), with one exception: **a plugin-data build**, which puts newly approved items into the HTML and publishes nothing else.

## The flow

1. **Approve.** The Owner, the AI or a declared visitor operation approves an item. It is live in the database at once (for comments: `comment_archive` → the published projection), so the gateway serves it through the delta fetch. No build.
2. **Mark.** The plugin declares which operations change its bakes (`bakedData`, below). After such an operation succeeds, the host marks the page stale in `plugin_data_stale_pages`:
   - an admin call (panel, chat, worker) is marked by the admin's plugin host right after dispatch (`packages/plugin-host/src/dispatch.ts`, `markBakedPagesStale` → `plugin_data.mark_pages`);
   - a visitor call is recorded by the gateway with its page id in `cms_public.gateway_plugin_op_events.page_id`. The admin reads it back as an **untrusted hint** (`packages/admin-core/src/plugin-data/visitor-hints.ts`): schema-checked, accepted only for a declared visitor trigger of a plugin this admin runs, under that plugin's own slug, and only for a main-line page that exists. The watermark logic is the one #844 hardened (contiguous ids, settled gaps, never past the sequence).
3. **Build, once per tick.** `runPluginDataBuildIfDue` (`plugin-data/worker.ts`) is the one entry point. Until the #1140 scheduler exists, `bootstrapMaintenanceWorkers()` calls it every 5 minutes. It runs `deploy.build_plugin_data` (`plugin-data/build.ts`), which takes every pending mark into one build. A try-lock and `minIntervalSeconds` keep it to one build per tick across admin instances.
4. **Since moves.** The rewritten region carries a new `data-baked-at`, taken from the database clock before the plugin reads its data. The delta fetch no longer returns the baked item.

## What the build renders from

It does not run the generator. `main` holds staged, unpublished and live-written changes, and drafts sit on the shared draft branch, so a build from `cms_admin` would publish them. The input is the **build that is live**: the newest succeeded deploy run on the production target (a Publish live, a rollback or an earlier plugin-data build), read back through the provider's publisher:

| Provider | Reads the live files from | Publishes |
|---|---|---|
| self-hosted | `<outDir>/builds/<build_id>/` | a copy as `builds/<runId>/`, mirrored into `current/` |
| gcp | the live static bucket | the replaced objects (keeping their Content-Type), then the live manifest |
| gcp-firebase | the live channel | a new version: the live version's config verbatim, every file by its hash except the replaced ones |
| aws, azure | not implemented (their publishers are stubs, #749 / #750) | — |

Within those files it replaces only **bake regions**: the markers the plugin pass writes around every bake (`apps/static-generator/src/bake-regions.ts`):

```html
<!--caelo-bake:comments:<pageId>:1.1.0--><div data-caelo-plugin="comments" data-page-id="<pageId>" data-baked-at="2026-10-26T10:00:00.000Z">…</div><!--/caelo-bake:comments:<pageId>-->
```

The plugin pass neutralises marker-shaped comments in the page HTML and in the plugin's output (`<!--caelo-bake:` → `<!-- caelo-bake:`), so only the pass itself opens or closes a region. The routing manifest names each page's file (`pages[].pageId`).

A region is refreshed only when:

- its plugin declares `bakedData` and has a stale mark for that page;
- the running plugin version rendered it (the version is on the start marker);
- the running Caelo version rendered the live build (`deploy_runs.caelo_version`);
- the plugin runs here and on every live server (#1008 `activePluginProblems`). Other plugins' health does not matter, because their regions and assets stay as published.

Otherwise the build reports `blocked` (with the reason) or leaves the region for the next Publish live. The publisher refuses when the live release is not the one the live run recorded (something was released outside Caelo).

The result is a deploy run with `build_kind = 'plugin_data'` and `base_run_id` = the live run. Its `plugin_data` column says what it baked. `deploy.build_plugin_data` audits it. When nothing changed (the data is the same as baked), the build publishes nothing and records no run. "When did a human last publish" (the dashboard, the editor toolbar, international-site's garbage collection) skips plugin-data runs.

Publish live of a Stage built before a plugin-data build, and a rollback, can take baked items out of the HTML again. Those items stay visible through the delta feed, because their region's `since` is older. `deploy.promote` (`rewindBakesToRun`) and `deploy.rollback` (`forgetAllBakes`) make those marks pending again, so the next tick re-bakes them.

**No quality gate.** The #553 audit checks page structure before a human publishes it. A plugin-data build keeps the structure: the same plugin version renders the same markup into a region the audited build already carried, with more or fewer data rows. **No SEO gate.** No `<head>` changes.

## Declaring baked data (plugin SDK)

A runnable example: a guestbook whose entries are approved in the admin and baked into their page.

```ts
// SPDX-License-Identifier: MPL-2.0
import { definePlugin, type PluginContextTier1 } from "@caelo-cms/plugin-sdk";

export default definePlugin<PluginContextTier1>({
  slug: "guestbook",
  version: "1.0.0",
  tier: 1,
  schema: {
    entries: { id: "uuid", page_id: "string", text: "text", status: "enum:pending,approved" },
  },
  publicOperations: ["sign", "list_approved"],
  operations: {
    // A visitor signs: pending, nothing baked changes. Not a trigger.
    sign: async (ctx, args) => {
      const { pageId, text } = args as { pageId: string; text: string };
      const r = await ctx.query.insert("entries", { page_id: pageId, text, status: "pending" });
      return { id: r.id };
    },
    // The Owner approves: this changes the page's baked list.
    approve: async (ctx, args) => {
      const { entryId } = args as { entryId: string };
      const [row] = await ctx.query.list<"entries", { page_id: string }>("entries", {
        id: entryId,
        limit: 1,
      });
      if (!row) throw new Error("approve: no such entry");
      await ctx.query.update("entries", entryId, { status: "approved" });
      return { entryId, pageId: row.page_id }; // ← the trigger reads `pageId` from here
    },
    list_approved: async (ctx, args) => {
      const { pageId } = args as { pageId: string };
      return {
        entries: await ctx.query.list("entries", { page_id: pageId, status: "approved", limit: 200 }),
      };
    },
  },
  // Throw on failure: an empty bake would take published entries off the page.
  staticRender: async (ctx, { pageId }) => {
    const rows = await ctx.query.list<"entries", { text: string }>("entries", {
      page_id: pageId,
      status: "approved",
      limit: 200,
    });
    return rows.map((r) => `<p>${r.text.replaceAll("<", "&lt;")}</p>`).join("");
  },
  // The bake cache key (static_bakes): change it when the data changes.
  metaSignature: async (ctx, { pageId }) =>
    String((await ctx.query.list("entries", { page_id: pageId, status: "approved", limit: 1000 })).length),
  bakedData: {
    description: "Approved guestbook entries, baked into the page they belong to.",
    triggers: [{ operation: "approve", pageIds: { from: "result", key: "pageId" } }],
  },
});
```

Rules (`pluginManifest`, `packages/plugin-sdk/src/index.ts`):

- `bakedData` needs a `staticRender`; every `triggers[].operation` is one of the plugin's operations.
- `pageIds.from` is `args` or `result`; `key` names a field holding a page id or a list of them (at most 1000). Anything else names no page.
- A trigger that is also in `publicOperations` is a **visitor trigger**. Its single page id travels with the gateway's op event and counts only as a hint (see above). Prefer an admin trigger (an approval) when the data is moderated.
- Only an active plugin declares anything: an inactive plugin is not loaded, so its triggers do not exist (CLAUDE.md §2).
- Return the page only when the baked data changed (comments return `pageId` only for an approval). A mark for unchanged data costs a re-render that publishes nothing.

The shipped `comments` plugin is the reference: `moderate`, `bulk_moderate` and `ai_moderate` are its triggers.

## Code map

| Piece | Where |
|---|---|
| Bake markers | `apps/static-generator/src/bake-regions.ts`, plugin pass `plugin-pass.ts` |
| Declaration | `packages/plugin-sdk/src/index.ts` (`bakedData`, `pluginBakedData`) |
| Page ids from a call | `packages/plugin-host/src/baked-data-pages.ts`; loaded-plugin checks `baked-data.ts` |
| Marks | `packages/admin-core/src/ops/plugin-data.ts`, `plugin-data/stale-pages.ts` |
| Visitor hints | `packages/admin-core/src/plugin-data/visitor-hints.ts` |
| The build | `packages/admin-core/src/plugin-data/build.ts` |
| The tick | `packages/admin-core/src/plugin-data/worker.ts`, started in `apps/admin/src/hooks.server.ts` |
| Publishers | `readLiveFiles` / `publishPluginData` in `packages/admin-core/src/deploy/static-publisher-*.ts` |
| Schema | `cms_admin` 0371 (`plugin_data_stale_pages`, `plugin_data_build_state`, `deploy_runs.build_kind` / `base_run_id` / `plugin_data`), `cms_public` 0372 (`gateway_plugin_op_events.page_id`) |
| Guard | `scripts/no-automatic-production-deploy.test.ts`: only the build calls `publishPluginData`, and it never runs the generator or the deploy ops |
