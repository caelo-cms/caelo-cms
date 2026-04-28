<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Layout } from "lucide-svelte";
  import EmptyStatePlaceholder from "$lib/components/EmptyStatePlaceholder.svelte";
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
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
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/components/ui/table/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";

  let { data, form } = $props();
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Templates</h1>
    <p class="text-sm text-muted-foreground">
      Layout shells with <code>&lt;caelo-slot name="…"&gt;</code> markers.
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Existing templates</CardTitle>
    </CardHeader>
    <CardContent>
      {#if data.templates.length === 0}
        <EmptyStatePlaceholder
          icon={Layout}
          title="No templates yet"
          description="Templates define the named blocks (header, content, footer) a page-type provides. Create one below to start binding pages to it."
        />
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Slug</TableHead>
              <TableHead>Display name</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.templates as t (t.id)}
              <TableRow>
                <TableCell>
                  <a class="font-medium underline-offset-4 hover:underline" href={`/content/templates/${t.id}`}>
                    {t.slug}
                  </a>
                </TableCell>
                <TableCell>{t.displayName}</TableCell>
                <TableCell class="text-muted-foreground">{t.updatedAt.slice(0, 10)}</TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {/if}
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">New template</CardTitle>
      <CardDescription>Templates own the page skeleton; modules fill the slots.</CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/create" class="space-y-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <div class="grid gap-4 md:grid-cols-2">
          <div class="space-y-2">
            <Label for="slug">Slug</Label>
            <Input id="slug" name="slug" type="text" pattern="[a-z0-9](?:[a-z0-9-]{'{0,62}'}[a-z0-9])?" required />
          </div>
          <div class="space-y-2">
            <Label for="displayName">Display name</Label>
            <Input id="displayName" name="displayName" type="text" required />
          </div>
        </div>
        <div class="space-y-2">
          <Label for="html">HTML</Label>
          <Textarea id="html" name="html" rows={10} class="font-mono text-xs" required />
        </div>
        <Button type="submit">Create</Button>
      </form>
    </CardContent>
  </Card>
</div>
