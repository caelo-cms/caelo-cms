<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { GripVertical } from "lucide-svelte";
  import { dndzone, type DndEvent } from "svelte-dnd-action";
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
  import { Select } from "$lib/components/ui/select/index.js";

  let { data, form } = $props();
  type Module = { moduleId: string; slug: string; displayName: string; isDeleted?: boolean };
  type Block = { blockName: string; modules: Module[] };
  const page = data.page as {
    id: string;
    slug: string;
    locale: string;
    title: string;
    status: "draft" | "published";
    templateId: string;
    version: number;
    deletedAt: string | null;
    blocks: Block[];
  };
  const allModules = data.allModules as { id: string; slug: string; displayName: string }[];
  const allTemplates = data.allTemplates as {
    id: string;
    slug: string;
    blocks: { name: string; displayName: string }[];
  }[];

  const template = allTemplates.find((t) => t.id === page.templateId);
  const slotNames = template?.blocks.map((b) => b.name) ?? [];
  const initial = new Map<string, Module[]>();
  for (const name of slotNames) initial.set(name, []);
  for (const b of page.blocks) initial.set(b.blockName, b.modules.slice());
  let layout = $state(
    [...initial.entries()].map(([blockName, modules]) => ({ blockName, modules })),
  );

  function addModule(blockName: string, moduleId: string): void {
    const m = allModules.find((x) => x.id === moduleId);
    if (!m) return;
    layout = layout.map((b) =>
      b.blockName === blockName
        ? {
            ...b,
            modules: [
              ...b.modules,
              { moduleId: m.id, slug: m.slug, displayName: m.displayName, isDeleted: false },
            ],
          }
        : b,
    );
  }
  function removeAt(blockName: string, idx: number): void {
    layout = layout.map((b) =>
      b.blockName === blockName
        ? { ...b, modules: b.modules.filter((_, i) => i !== idx) }
        : b,
    );
  }
  function moveUp(blockName: string, idx: number): void {
    if (idx === 0) return;
    layout = layout.map((b) => {
      if (b.blockName !== blockName) return b;
      const next = b.modules.slice();
      const tmp = next[idx];
      const above = next[idx - 1];
      if (!tmp || !above) return b;
      next[idx - 1] = tmp;
      next[idx] = above;
      return { ...b, modules: next };
    });
  }

  // P6.6b — drag-and-drop reordering. svelte-dnd-action requires a
  // stable `id` per item; we synthesize `${blockName}:${moduleId}:${i}`
  // because the same moduleId can appear in multiple blocks of the
  // same page. The `consider` event fires during the drag (used to
  // animate the live position); `finalize` is the commit point that
  // updates `layout` so the hidden form input picks up the new order.
  type DraggableModule = Module & { id: string };

  function withDragIds(modules: Module[], blockName: string): DraggableModule[] {
    return modules.map((m, i) => ({ ...m, id: `${blockName}:${m.moduleId}:${i}` }));
  }
  function stripDragIds(items: DraggableModule[]): Module[] {
    return items.map(({ id: _ignored, ...rest }) => rest);
  }

  function onDndConsider(blockName: string, e: CustomEvent<DndEvent<DraggableModule>>): void {
    layout = layout.map((b) =>
      b.blockName === blockName ? { ...b, modules: stripDragIds(e.detail.items) } : b,
    );
  }
  function onDndFinalize(blockName: string, e: CustomEvent<DndEvent<DraggableModule>>): void {
    layout = layout.map((b) =>
      b.blockName === blockName ? { ...b, modules: stripDragIds(e.detail.items) } : b,
    );
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">
      {page.slug}
      <span class="text-base text-muted-foreground">({page.locale})</span>
    </h1>
    <div class="mt-1 flex gap-3 text-sm text-muted-foreground">
      <a class="underline" href={`/content/pages/${page.id}/preview`} target="_blank" rel="noopener"
        >Open preview ↗</a
      >
      <a class="underline" href={`/content/pages/${page.id}/history`}>View history ↗</a>
    </div>
  </div>

  {#if page.deletedAt}
    <Alert variant="destructive">
      <AlertDescription>This page is soft-deleted ({page.deletedAt}).</AlertDescription>
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
      <CardTitle class="text-base">Metadata</CardTitle>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/update" class="grid gap-4 md:grid-cols-2">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <input type="hidden" name="expectedVersion" value={page.version} />
        <div class="space-y-2">
          <Label for="title">Title</Label>
          <Input id="title" name="title" type="text" value={page.title} required />
        </div>
        <div class="space-y-2">
          <Label for="status">Status</Label>
          <Select id="status" name="status">
            <option value="draft" selected={page.status === "draft"}>Draft</option>
            <option value="published" selected={page.status === "published"}>Published</option>
          </Select>
        </div>
        <div class="md:col-span-2">
          <Button type="submit">Save metadata</Button>
        </div>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Layout</CardTitle>
      <CardDescription>Pages reference modules — drop them into the template's slots.</CardDescription>
    </CardHeader>
    <CardContent>
      {#if !template}
        <Alert variant="destructive">
          <AlertDescription>Template not found — this page references a deleted template.</AlertDescription>
        </Alert>
      {:else}
        <form method="post" action="?/setModules" class="space-y-6">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <input type="hidden" name="expectedVersion" value={page.version} />
          {#each layout as block (block.blockName)}
            <fieldset class="rounded-lg border p-4">
              <legend class="px-2 text-sm font-semibold">{block.blockName}</legend>
              <input
                type="hidden"
                name={`blocks[${block.blockName}]`}
                value={block.modules.map((m) => m.moduleId).join(",")}
              />
              {#if block.modules.length === 0}
                <p class="text-sm text-muted-foreground"><em>(empty)</em></p>
              {:else}
                <!-- P6.6b — drag-and-drop reordering.
                     dndzone returns items as a fresh array on every
                     `consider` event; we strip the synthetic ids in
                     onDndConsider/onDndFinalize before persisting back
                     to `layout`. The ↑/× buttons stay as keyboard-
                     accessible fallbacks for users who can't drag. -->
                <ol
                  class="space-y-1 text-sm"
                  use:dndzone={{
                    items: withDragIds(block.modules, block.blockName),
                    flipDurationMs: 150,
                    dropTargetStyle: {},
                  }}
                  onconsider={(e: CustomEvent<DndEvent<DraggableModule>>) =>
                    onDndConsider(block.blockName, e)}
                  onfinalize={(e: CustomEvent<DndEvent<DraggableModule>>) =>
                    onDndFinalize(block.blockName, e)}
                >
                  {#each withDragIds(block.modules, block.blockName) as m (m.id)}
                    <li
                      class="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1"
                      data-id={m.id}
                    >
                      <span
                        class="cursor-grab text-muted-foreground motion-reduce:cursor-default"
                        aria-label="Drag to reorder"
                      >
                        <GripVertical class="size-4" aria-hidden="true" />
                      </span>
                      <span class="flex-1">
                        <span class="font-medium">{m.slug}</span> — {m.displayName}
                        {#if m.isDeleted}
                          <span class="text-destructive">(deleted)</span>
                        {/if}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label="Move up"
                        onclick={() =>
                          moveUp(
                            block.blockName,
                            block.modules.findIndex((x) => x.moduleId === m.moduleId),
                          )}>↑</Button
                      >
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label="Remove"
                        onclick={() =>
                          removeAt(
                            block.blockName,
                            block.modules.findIndex((x) => x.moduleId === m.moduleId),
                          )}>×</Button
                      >
                    </li>
                  {/each}
                </ol>
              {/if}
              <div class="mt-3 space-y-2">
                <Label for={`add-module-${block.blockName}`}>Add module</Label>
                <Select
                  id={`add-module-${block.blockName}`}
                  onchange={(e: Event) => {
                    const target = e.currentTarget as HTMLSelectElement;
                    const value = target.value;
                    if (value) addModule(block.blockName, value);
                    target.value = "";
                  }}
                >
                  <option value="">…</option>
                  {#each allModules as m (m.id)}
                    <option value={m.id}>{m.slug} — {m.displayName}</option>
                  {/each}
                </Select>
              </div>
            </fieldset>
          {/each}
          <Button type="submit">Save layout</Button>
        </form>
      {/if}
    </CardContent>
  </Card>

  {#if !page.deletedAt}
    <Card class="border-destructive/50">
      <CardHeader>
        <CardTitle class="text-base text-destructive">Danger zone</CardTitle>
      </CardHeader>
      <CardContent>
        <form method="post" action="?/delete">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <Button type="submit" variant="destructive">Soft-delete this page</Button>
        </form>
      </CardContent>
    </Card>
  {/if}
</div>
