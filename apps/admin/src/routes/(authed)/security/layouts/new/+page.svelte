<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { buttonVariants } from "$lib/components/ui/button/button-variants.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";

  let { data, form } = $props();

  let blocks = $state<{ name: string; displayName: string; position: number }[]>([
    { name: "header", displayName: "Header", position: 0 },
    { name: "content", displayName: "Content", position: 1 },
    { name: "footer", displayName: "Footer", position: 2 },
  ]);

  function addBlock() {
    blocks = [
      ...blocks,
      { name: "", displayName: "", position: blocks.length },
    ];
  }
  function removeBlock(idx: number) {
    blocks = blocks.filter((_, i) => i !== idx);
  }
</script>

<div class="space-y-6">
  <div class="flex items-center gap-2">
    <a href="/security/layouts" class={buttonVariants({ variant: "outline", size: "sm" })}>← Back</a>
    <h1 class="text-2xl font-semibold tracking-tight">New layout</h1>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Layout details</CardTitle>
    </CardHeader>
    <CardContent>
      <form method="post" class="space-y-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />

        <div class="grid gap-4 md:grid-cols-2">
          <div class="space-y-2">
            <Label for="slug">Slug</Label>
            <Input
              id="slug"
              name="slug"
              type="text"
              required
              pattern={"[a-z0-9][a-z0-9\\-]*"}
              placeholder="campaign-banner"
            />
            <p class="text-xs text-muted-foreground">Lowercase letters, digits, hyphens.</p>
          </div>
          <div class="space-y-2">
            <Label for="displayName">Display name</Label>
            <Input
              id="displayName"
              name="displayName"
              type="text"
              required
              placeholder="Campaign banner layout"
            />
          </div>
        </div>

        <div class="space-y-2">
          <Label for="html">HTML</Label>
          <textarea
            id="html"
            name="html"
            required
            rows="10"
            class="block w-full rounded-md border bg-background p-2 font-mono text-xs"
            placeholder={'<!doctype html><html><head><meta charset="utf-8"></head><body><caelo-slot name="content">_</caelo-slot></body></html>'}
          ></textarea>
          <p class="text-xs text-muted-foreground">
            Must include <code>&lt;caelo-slot name="content"&gt;…&lt;/caelo-slot&gt;</code> — that's
            where each page's body lands. Other named slots (header / footer / nav) get filled by
            <code>add_module_to_layout</code>.
          </p>
        </div>

        <div class="space-y-2">
          <Label for="css">CSS (optional)</Label>
          <textarea
            id="css"
            name="css"
            rows="4"
            class="block w-full rounded-md border bg-background p-2 font-mono text-xs"
          ></textarea>
        </div>

        <fieldset class="space-y-3 rounded-md border p-3">
          <legend class="px-1 text-sm font-medium">Blocks</legend>
          {#each blocks as block, i (i)}
            <div class="grid gap-2 md:grid-cols-[1fr_1fr_8rem_auto]">
              <Input
                name="blockName"
                type="text"
                required
                placeholder="content"
                value={block.name}
              />
              <Input
                name="blockDisplayName"
                type="text"
                placeholder="Content"
                value={block.displayName}
              />
              <Input
                name="blockPosition"
                type="number"
                min="0"
                max="1000"
                value={block.position}
              />
              <Button type="button" variant="ghost" size="sm" onclick={() => removeBlock(i)}>
                Remove
              </Button>
            </div>
          {/each}
          <Button type="button" variant="outline" size="sm" onclick={addBlock}>+ Add block</Button>
          <p class="text-xs text-muted-foreground">
            Exactly one block must be named <code>content</code>.
          </p>
        </fieldset>

        <div class="flex justify-end gap-2">
          <a href="/security/layouts" class={buttonVariants({ variant: "outline" })}>Cancel</a>
          <Button type="submit">Create layout</Button>
        </div>
      </form>
    </CardContent>
  </Card>
</div>
