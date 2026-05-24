<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { GripVertical, Trash2 } from "lucide-svelte";
  import { dndzone, type DndEvent } from "svelte-dnd-action";
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
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

  // P6.6b — block editor. Items load from the server as
  // { name, displayName, position }; we sort + assign synthetic ids
  // for dnd, then strip them on save. The `content` block is required
  // (the renderer validates this); the UI prevents removing the last
  // `content` row by disabling the trash button on it.
  type Block = { id: string; name: string; displayName: string; position: number };
  const initial: Block[] = data.layout.blocks
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((b, i) => ({ id: `${b.name}:${i}`, ...b }));
  let blocks = $state<Block[]>(initial);

  function onDndConsider(e: CustomEvent<DndEvent<Block>>): void {
    blocks = e.detail.items;
  }
  function onDndFinalize(e: CustomEvent<DndEvent<Block>>): void {
    blocks = e.detail.items;
  }
  function addBlock(): void {
    blocks = [
      ...blocks,
      { id: `new:${Date.now()}`, name: "", displayName: "", position: blocks.length },
    ];
  }
  function removeBlock(idx: number): void {
    blocks = blocks.filter((_, i) => i !== idx);
  }

  // The serialised payload re-numbers `position` by current order so
  // the d&d reorder always wins over the previously-stored positions.
  const serialisedBlocks = $derived(
    JSON.stringify(
      blocks.map((b, i) => ({
        name: b.name.trim(),
        displayName: b.displayName.trim() || b.name.trim(),
        position: i,
      })),
    ),
  );
  const hasContentBlock = $derived(blocks.some((b) => b.name.trim() === "content"));
</script>

<div class="space-y-6">
  <div class="flex items-center gap-2">
    <a href="/security/layouts" class={buttonVariants({ variant: "outline", size: "sm" })}>← Back</a>
    <h1 class="text-2xl font-semibold tracking-tight">Edit layout</h1>
    <Badge variant="outline">{data.layout.slug}</Badge>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {:else if form?.message}
    <Alert><AlertDescription>{form.message}</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Layout HTML / CSS</CardTitle>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/update" class="space-y-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <div class="space-y-2">
          <Label for="displayName">Display name</Label>
          <Input id="displayName" name="displayName" type="text" required value={data.layout.displayName} />
        </div>
        <div class="space-y-2">
          <Label for="html">HTML</Label>
          <textarea
            id="html"
            name="html"
            required
            rows="10"
            class="block w-full rounded-md border bg-background p-2 font-mono text-xs">{data.layout.html}</textarea>
          <p class="text-xs text-muted-foreground">
            Must contain <code>&lt;caelo-slot name="content"&gt;…&lt;/caelo-slot&gt;</code>.
          </p>
        </div>
        <div class="space-y-2">
          <Label for="css">CSS</Label>
          <textarea
            id="css"
            name="css"
            rows="6"
            class="block w-full rounded-md border bg-background p-2 font-mono text-xs">{data.layout.css}</textarea>
        </div>
        <div class="flex justify-end">
          <Button type="submit">Save changes</Button>
        </div>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Blocks</CardTitle>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/setBlocks" class="space-y-3">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <input type="hidden" name="blocks" value={serialisedBlocks} />
        <ul
          class="space-y-2"
          use:dndzone={{ items: blocks, flipDurationMs: 150, dropTargetStyle: {} }}
          onconsider={onDndConsider}
          onfinalize={onDndFinalize}
        >
          {#each blocks as block, idx (block.id)}
            <li
              class="flex items-center gap-2 rounded-md border bg-background p-2"
              data-id={block.id}
            >
              <span
                class="cursor-grab text-muted-foreground motion-reduce:cursor-default"
                aria-label="Drag to reorder"
              >
                <GripVertical class="size-4" aria-hidden="true" />
              </span>
              <Input
                type="text"
                placeholder="name (e.g. content, header, footer)"
                pattern={"[a-z0-9](?:[a-z0-9\\-]{0,62}[a-z0-9])?"}
                required
                value={block.name}
                oninput={(e: Event) => {
                  blocks = blocks.map((b, i) =>
                    i === idx ? { ...b, name: (e.currentTarget as HTMLInputElement).value } : b,
                  );
                }}
                class="flex-1"
              />
              <Input
                type="text"
                placeholder="display name"
                value={block.displayName}
                oninput={(e: Event) => {
                  blocks = blocks.map((b, i) =>
                    i === idx
                      ? { ...b, displayName: (e.currentTarget as HTMLInputElement).value }
                      : b,
                  );
                }}
                class="flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Remove block"
                disabled={block.name.trim() === "content" && !blocks.some(
                  (b, i) => i !== idx && b.name.trim() === "content",
                )}
                title={block.name.trim() === "content"
                  ? "The `content` block is required by the renderer"
                  : "Remove block"}
                onclick={() => removeBlock(idx)}
              >
                <Trash2 class="size-4" />
              </Button>
            </li>
          {/each}
        </ul>
        {#if !hasContentBlock}
          <p class="text-xs text-destructive">
            A block named <code>content</code> is required — the renderer fills the page body into
            it.
          </p>
        {/if}
        <div class="flex items-center justify-between gap-2">
          <Button type="button" variant="outline" size="sm" onclick={addBlock}>+ Add block</Button>
          <Button type="submit" disabled={!hasContentBlock}>Save blocks</Button>
        </div>
        <p class="text-xs text-muted-foreground">
          Drag the handle to reorder. Removing a block fails if any layout-modules still reference
          it — detach those first via <code>remove_module_from_layout</code>.
        </p>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base text-destructive">Danger zone</CardTitle>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/delete">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <Button type="submit" variant="destructive">Delete layout</Button>
        <p class="mt-2 text-xs text-muted-foreground">
          Refused if any non-deleted template still references this layout — re-point them first.
        </p>
      </form>
    </CardContent>
  </Card>
</div>
