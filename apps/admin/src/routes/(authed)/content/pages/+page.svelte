<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { enhance } from "$app/forms";
  import { pageCreateSchema } from "@caelo-cms/shared";
  import { FileText } from "lucide-svelte";
  import EmptyStatePlaceholder from "#lib/components/EmptyStatePlaceholder.svelte";
  import StateDot from "#lib/components/StateDot.svelte";
  import { pageStatusMark } from "#lib/components/state-dot.js";
  import { bindZodForm } from "#lib/forms/zod-bind.svelte.js";
  import { orderAsTree, parentCandidates } from "#lib/page-tree.js";
  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Select } from "#lib/components/ui/select/index.js";
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "#lib/components/ui/table/index.js";

  let { data, form } = $props();

  // P6.6a — client-side Zod validation mirrors the same schema the
  // server enforces, so the user sees per-field errors as they type.
  // Slug uniqueness still requires a server round-trip; that error
  // surfaces via the `form?.error` Alert above.
  const createForm = bindZodForm(pageCreateSchema, { status: "draft" });

  // Run #9 R10 (issue #262) — bulk publish. Drafts never ship to
  // staging/production; a migration's 30-150 draft pages need one
  // action, not one click per row.
  const draftCount = $derived(data.pages.filter((p) => p.status === "draft").length);
  // Epic #690 — pages nest: list them as a tree (children under their
  // parent, indented) and let a new page start under any section.
  const treeRows = $derived(orderAsTree(data.pages));
  const parentOptions = $derived(
    parentCandidates(data.pages, null).sort((a, b) => a.currentPath.localeCompare(b.currentPath)),
  );
  let bulkPublishing = $state(false);
  // #1276 — the page type is a required choice; the template list then
  // shows only that type's templates.
  let chosenPageType = $state("");
  const chosenType = $derived(data.pageTypes.find((t) => t.slug === chosenPageType));
  const templateName = (id: string) => {
    const t = data.templates.find((x) => x.id === id);
    return t ? `${t.slug} — ${t.displayName}` : id;
  };
</script>

<div class="space-y-6">
  <div class="flex items-baseline justify-between">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Pages</h1>
      <p class="text-sm text-muted-foreground">
        Compose pages from modules; Stage to staging, then Confirm publish to production.
      </p>
    </div>
  </div>

  {#if form?.error}
    <Alert variant="destructive">
      <AlertDescription>{form.error}</AlertDescription>
    </Alert>
  {/if}
  {#if form?.published}
    <Alert>
      <AlertDescription>Published to production.</AlertDescription>
    </Alert>
  {/if}
  {#if form?.staged}
    <Alert>
      <AlertDescription>
        Staged — {form.staged.pageCount} page(s), {form.staged.fileCount} file(s) on staging.
        Preview:
        <a class="underline" href={form.staged.previewUrl} target="_blank" rel="noopener"
          >{form.staged.previewLabel}</a
        >. Click <strong>Confirm publish</strong> below to ship to production.
      </AlertDescription>
    </Alert>
  {/if}

  <Card>
    <CardHeader>
      <div class="flex items-center justify-between gap-4">
        <CardTitle class="text-base">Existing pages</CardTitle>
        {#if draftCount > 0}
          <!-- Publishes page STATUS only — production still requires the
               explicit Stage → Confirm publish flow. use:enhance keeps the
               URL clean so a refresh doesn't re-submit. -->
          <form
            method="post"
            action="?/publishAllDrafts"
            use:enhance={() => {
              bulkPublishing = true;
              return async ({ update }) => {
                try {
                  await update({ reset: false });
                } finally {
                  bulkPublishing = false;
                }
              };
            }}
          >
            <input type="hidden" name="_csrf" value={data.csrfToken} />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={bulkPublishing}
              data-testid="publish-all-drafts-btn"
              title="Set every draft page to published so the next Stage includes it. Nothing reaches production until you confirm."
            >
              {bulkPublishing ? "Publishing…" : `Publish ${draftCount} draft page(s)`}
            </Button>
          </form>
        {/if}
      </div>
    </CardHeader>
    <CardContent>
      {#if data.pages.length === 0}
        <EmptyStatePlaceholder
          icon={FileText}
          title="No pages yet"
          description="Pages are how visitors find your site. Create one below to start composing modules into a published URL."
        />
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Page</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead class="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each treeRows as { row: p, depth } (p.id)}
              <TableRow data-testid="page-row" data-depth={depth}>
                <TableCell>
                  <!-- Indented under its parent; the full URL path is the
                       page's address (parent chain + slug). -->
                  <div class="flex flex-col" style={`padding-left: ${depth * 1.25}rem`}>
                    <a
                      class="font-medium underline-offset-4 hover:underline"
                      href={`/content/pages/${p.id}`}
                    >
                      {depth > 0 ? "↳ " : ""}{p.slug}
                    </a>
                    <span class="text-xs text-muted-foreground">{p.currentPath}</span>
                  </div>
                </TableCell>
                <TableCell>{p.title}</TableCell>
                <TableCell>
                  <!-- #779 — the page STATUS, Draft or Published. Whether
                       a published page is on staging or live is not
                       tracked per page, so the list never shows Preview /
                       Live (those live on the toolbar and dashboard). -->
                  <StateDot state={pageStatusMark(p.status)} />
                </TableCell>
                <TableCell class="text-muted-foreground">{p.updatedAt.slice(0, 10)}</TableCell>
                <TableCell class="text-right">
                  {#if form?.staged?.pageId === p.id}
                    <!-- use:enhance — submitting via XHR keeps the URL
                         clean (`/content/pages` instead of
                         `/content/pages?/confirmPublish`) so a refresh
                         doesn't re-promote the staging build. -->
                    <form method="post" action="?/confirmPublish" use:enhance class="inline">
                      <input type="hidden" name="_csrf" value={data.csrfToken} />
                      <input type="hidden" name="pageId" value={p.id} />
                      <!-- #779 — promotes staging to production: the
                           human Publish-live decision, so coral. -->
                      <Button type="submit" size="sm" variant="decide">Confirm publish</Button>
                    </form>
                  {:else}
                    <form method="post" action="?/stage" use:enhance class="inline">
                      <input type="hidden" name="_csrf" value={data.csrfToken} />
                      <input type="hidden" name="pageId" value={p.id} />
                      <Button type="submit" size="sm" variant="outline">Stage</Button>
                    </form>
                  {/if}
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {/if}
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">New page</CardTitle>
      <CardDescription>Pages reference modules — they never carry raw HTML.</CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.templates.length === 0 || data.pageTypes.length === 0}
        <p class="text-sm text-muted-foreground">
          <em>Create a <a class="underline" href="/content/templates">template</a> and its page type first.</em>
        </p>
      {:else}
        <form method="post" action="?/create" class="grid gap-4 md:grid-cols-2">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <div class="space-y-2">
            <Label for="slug">Slug</Label>
            <Input
              id="slug"
              name="slug"
              type="text"
              pattern={"[a-z0-9](?:[a-z0-9\\-]{0,62}[a-z0-9])?"}
              required
              aria-invalid={createForm.errors.slug ? "true" : undefined}
              aria-describedby={createForm.errors.slug ? "slug-err" : undefined}
              oninput={(e) => createForm.update("slug", (e.currentTarget as HTMLInputElement).value)}
            />
            {#if createForm.errors.slug}
              <p id="slug-err" class="text-xs text-destructive">{createForm.errors.slug}</p>
            {/if}
          </div>
          <div class="space-y-2">
            <Label for="title">Title</Label>
            <Input
              id="title"
              name="title"
              type="text"
              required
              aria-invalid={createForm.errors.title ? "true" : undefined}
              aria-describedby={createForm.errors.title ? "title-err" : undefined}
              oninput={(e) =>
                createForm.update("title", (e.currentTarget as HTMLInputElement).value)}
            />
            {#if createForm.errors.title}
              <p id="title-err" class="text-xs text-destructive">{createForm.errors.title}</p>
            {/if}
          </div>
          <div class="space-y-2">
            <Label for="parentPageId">Parent page</Label>
            <Select id="parentPageId" name="parentPageId">
              <option value="">(top level)</option>
              {#each parentOptions as p (p.id)}
                <option value={p.id}>{p.currentPath} — {p.title}</option>
              {/each}
            </Select>
          </div>
          <div class="space-y-2">
            <Label for="pageType">Page type</Label>
            <Select
              id="pageType"
              name="pageType"
              required
              bind:value={chosenPageType}
              onchange={(e) =>
                createForm.update(
                  "pageType",
                  (e.currentTarget as HTMLSelectElement).value || undefined,
                )}
            >
              <option value="" disabled>Choose what this page is…</option>
              {#each data.pageTypes as t (t.slug)}
                <option value={t.slug}>{t.name} ({t.slug}, {t.pageCount} page(s))</option>
              {/each}
            </Select>
            {#if chosenType}
              <p class="text-xs text-muted-foreground">{chosenType.purpose}</p>
            {/if}
          </div>
          <div class="space-y-2">
            <Label for="templateId">Template</Label>
            <Select
              id="templateId"
              name="templateId"
              disabled={!chosenType}
              onchange={(e) =>
                createForm.update(
                  "templateId",
                  (e.currentTarget as HTMLSelectElement).value || undefined,
                )}
            >
              {#if chosenType}
                {#each chosenType.templates as id (id)}
                  <option value={id} selected={id === chosenType.defaultTemplate}
                    >{templateName(id)}</option
                  >
                {/each}
              {:else}
                <option value="">Choose a page type first</option>
              {/if}
            </Select>
          </div>
          <div class="md:col-span-2">
            <!-- Submit stays enabled — Playwright `fill()` doesn't
                 always trip our oninput handler, and the server is
                 authoritative anyway. Inline errors are advisory. -->
            <Button type="submit">Create</Button>
          </div>
        </form>
      {/if}
    </CardContent>
  </Card>
</div>
