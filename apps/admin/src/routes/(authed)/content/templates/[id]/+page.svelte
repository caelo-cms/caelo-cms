<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
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
  import { Textarea } from "$lib/components/ui/textarea/index.js";

  let { data, form } = $props();
  const template = data.template as {
    id: string;
    slug: string;
    displayName: string;
    html: string;
    css: string;
    deletedAt: string | null;
    blocks: { name: string; displayName: string; position: number }[];
  };
  let blocks = $state(
    template.blocks.length > 0
      ? template.blocks.map((b) => ({ name: b.name, displayName: b.displayName }))
      : [{ name: "content", displayName: "Content" }],
  );
  function addBlock(): void {
    blocks = [...blocks, { name: "", displayName: "" }];
  }
  function removeBlock(i: number): void {
    blocks = blocks.filter((_, idx) => idx !== i);
  }
</script>

<div class="space-y-6">
  <h1 class="text-2xl font-semibold tracking-tight">{template.slug}</h1>

  {#if template.deletedAt}
    <Alert variant="destructive">
      <AlertDescription>This template is soft-deleted ({template.deletedAt}).</AlertDescription>
    </Alert>
  {/if}
  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>Saved.</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Skeleton</CardTitle>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/update" class="space-y-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <div class="space-y-2">
          <Label for="displayName">Display name</Label>
          <Input id="displayName" name="displayName" type="text" value={template.displayName} required />
        </div>
        <div class="space-y-2">
          <Label for="html">HTML</Label>
          <Textarea id="html" name="html" rows={14} class="font-mono text-xs" value={template.html} />
        </div>
        <div class="space-y-2">
          <Label for="css">CSS</Label>
          <Textarea id="css" name="css" rows={6} class="font-mono text-xs" value={template.css} />
        </div>
        <Button type="submit">Save skeleton</Button>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Blocks (slot inventory)</CardTitle>
      <CardDescription>
        Each row matches a <code>&lt;caelo-slot name="…"&gt;</code> in the HTML.
        Saving replaces the entire block list atomically.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/setBlocks" class="space-y-3">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        {#each blocks as block, i (i)}
          <div class="flex items-center gap-2">
            <Input
              name={`blockName.${i}`}
              type="text"
              placeholder="slot name (e.g. content)"
              bind:value={block.name}
              pattern={"[a-z0-9](?:[a-z0-9\\-]{0,62}[a-z0-9])?"}
            />
            <Input
              name={`blockDisplay.${i}`}
              type="text"
              placeholder="display name"
              bind:value={block.displayName}
            />
            <Button type="button" variant="ghost" size="sm" onclick={() => removeBlock(i)}>×</Button>
          </div>
        {/each}
        <div class="flex gap-2">
          <Button type="button" variant="outline" onclick={addBlock}>+ Add block</Button>
          <Button type="submit">Save blocks</Button>
        </div>
      </form>
    </CardContent>
  </Card>

  {#if !template.deletedAt}
    <Card class="border-destructive/50">
      <CardHeader>
        <CardTitle class="text-base text-destructive">Danger zone</CardTitle>
      </CardHeader>
      <CardContent>
        <form method="post" action="?/delete">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <Button type="submit" variant="destructive">Soft-delete this template</Button>
        </form>
      </CardContent>
    </Card>
  {/if}
</div>
