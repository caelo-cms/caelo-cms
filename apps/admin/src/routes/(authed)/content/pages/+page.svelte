<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { enhance } from "$app/forms";
  import { pageCreateSchema } from "@caelo-cms/shared";
  import { FileText } from "lucide-svelte";
  import EmptyStatePlaceholder from "$lib/components/EmptyStatePlaceholder.svelte";
  import { bindZodForm } from "$lib/forms/zod-bind.svelte.js";
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Select } from "$lib/components/ui/select/index.js";
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/components/ui/table/index.js";

  let { data, form } = $props();

  // P6.6a — client-side Zod validation mirrors the same schema the
  // server enforces, so the user sees per-field errors as they type.
  // Slug uniqueness still requires a server round-trip; that error
  // surfaces via the `form?.error` Alert above.
  const createForm = bindZodForm(pageCreateSchema, { locale: "en", status: "draft" });
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
          >{form.staged.previewUrl}</a
        >. Click <strong>Confirm publish</strong> below to ship to production.
      </AlertDescription>
    </Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Existing pages</CardTitle>
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
              <TableHead>Slug</TableHead>
              <TableHead>Locale</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead class="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.pages as p (p.id)}
              <TableRow>
                <TableCell>
                  <a class="font-medium underline-offset-4 hover:underline" href={`/content/pages/${p.id}`}>
                    {p.slug}
                  </a>
                </TableCell>
                <TableCell>{p.locale}</TableCell>
                <TableCell>{p.title}</TableCell>
                <TableCell>
                  <Badge variant={p.status === "published" ? "success" : "secondary"}>
                    {p.status}
                  </Badge>
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
                      <Button type="submit" size="sm">Confirm publish</Button>
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
      {#if data.templates.length === 0}
        <p class="text-sm text-muted-foreground">
          <em>Create a <a class="underline" href="/content/templates">template</a> first.</em>
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
            <Label for="locale">Locale</Label>
            <Input
              id="locale"
              name="locale"
              type="text"
              value="en"
              pattern="[a-z]{'{2}'}(-[A-Z]{'{2}'})?"
              required
              aria-invalid={createForm.errors.locale ? "true" : undefined}
              aria-describedby={createForm.errors.locale ? "locale-err" : undefined}
              oninput={(e) =>
                createForm.update("locale", (e.currentTarget as HTMLInputElement).value)}
            />
            {#if createForm.errors.locale}
              <p id="locale-err" class="text-xs text-destructive">{createForm.errors.locale}</p>
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
            <Label for="templateId">Template</Label>
            <Select
              id="templateId"
              name="templateId"
              required
              onchange={(e) =>
                createForm.update(
                  "templateId",
                  (e.currentTarget as HTMLSelectElement).value || undefined,
                )}
            >
              {#each data.templates as t (t.id)}
                <option value={t.id}>{t.slug} — {t.displayName}</option>
              {/each}
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
