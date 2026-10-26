<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * One level of the list editor's tree (epic #1107), recursive for the
   * levels below. Drag and drop reorders and nests entries; while an entry
   * is dragged, every level the list type does not allow it on refuses the
   * drop (`canPlace`: node kind, `max`, depth), so the operator cannot
   * build a tree the save would refuse. The buttons on each row do the same
   * moves for keyboard users and for touch screens.
   */

  import type { ListTypeDef } from "@caelo-cms/shared";
  import {
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    ArrowUp,
    GripVertical,
    Plus,
    Trash2,
  } from "lucide-svelte";
  import { type DndEvent, dndzone, TRIGGERS } from "svelte-dnd-action";
  import { entrySummary } from "#lib/lists/field-form.js";
  import {
    addableKinds,
    canPlace,
    type EditorItem,
    levelRule,
    nodeLabel,
    removeItem,
  } from "#lib/lists/tree.js";
  import { cn } from "#lib/utils.js";
  import Self from "./ListTreeLevel.svelte";

  type Action = "up" | "down" | "indent" | "outdent" | "remove";

  interface Props {
    def: ListTypeDef;
    /** The whole tree (placement checks need it). */
    tree: EditorItem[];
    /** This level's entries. */
    items: EditorItem[];
    parentId: string | null;
    depth: number;
    selectedId: string | null;
    readOnly: boolean;
    /** The entry being dragged right now, if any (shared by every level). */
    dragging: EditorItem | null;
    onselect: (id: string) => void;
    onlevel: (parentId: string | null, items: EditorItem[], final: boolean) => void;
    ondragstart: (id: string) => void;
    onaction: (action: Action, id: string) => void;
    onadd: (parentId: string | null, node: string) => void;
  }
  let {
    def,
    tree,
    items,
    parentId,
    depth,
    selectedId,
    readOnly,
    dragging,
    onselect,
    onlevel,
    ondragstart,
    onaction,
    onadd,
  }: Props = $props();

  const multipleKinds = $derived(Object.keys(def.nodes).length > 1);
  /** Drops from other levels: only an entry the type allows here. */
  const refuseDrop = $derived(
    dragging !== null &&
      !items.some((i) => i.id === dragging.id) &&
      !canPlace(def, removeItem(tree, dragging.id), dragging, parentId).ok,
  );

  function consider(e: CustomEvent<DndEvent<EditorItem>>): void {
    if (e.detail.info.trigger === TRIGGERS.DRAG_STARTED) ondragstart(String(e.detail.info.id));
    onlevel(parentId, e.detail.items, false);
  }
  function finalize(e: CustomEvent<DndEvent<EditorItem>>): void {
    onlevel(parentId, e.detail.items, true);
  }
</script>

<ul
  class={cn("min-h-6 space-y-1", depth > 1 && "ml-6 border-l pl-2")}
  aria-label={depth === 1 ? "Entries" : undefined}
  use:dndzone={{
    items,
    type: "list-entry",
    flipDurationMs: 120,
    dragDisabled: readOnly,
    dropFromOthersDisabled: refuseDrop,
    dropTargetStyle: { outline: "2px dashed var(--ring)" },
  }}
  onconsider={consider}
  onfinalize={finalize}
>
  {#each items as it (it.id)}
    {@const kids = levelRule(def, it.node)}
    {@const addable = readOnly ? [] : addableKinds(def, tree, it.id)}
    <li data-testid="list-entry" data-entry-id={it.id}>
      <div
        class={cn(
          "group flex items-center gap-1 rounded-md border bg-card px-2 py-1 text-sm",
          selectedId === it.id && "border-primary ring-1 ring-primary",
        )}
      >
        {#if !readOnly}
          <span class="cursor-grab text-muted-foreground" aria-hidden="true">
            <GripVertical class="size-4" />
          </span>
        {/if}
        <button
          type="button"
          class="min-w-0 flex-1 truncate text-left"
          data-testid="entry-select"
          onclick={() => onselect(it.id)}
        >
          {entrySummary(def, it.node, it.values)}
          {#if multipleKinds}
            <span class="ml-1 text-xs text-muted-foreground">· {nodeLabel(def, it.node)}</span>
          {/if}
          {#if def.nodes[it.node]?.source}
            <span class="ml-1 text-xs text-muted-foreground">· filled automatically</span>
          {/if}
        </button>
        {#if !readOnly}
          <div class="flex items-center opacity-70 group-hover:opacity-100">
            <button type="button" class="rounded p-1 hover:bg-accent" aria-label="Move up" onclick={() => onaction("up", it.id)}><ArrowUp class="size-3.5" /></button>
            <button type="button" class="rounded p-1 hover:bg-accent" aria-label="Move down" onclick={() => onaction("down", it.id)}><ArrowDown class="size-3.5" /></button>
            <button type="button" class="rounded p-1 hover:bg-accent" aria-label="Nest under the entry above" onclick={() => onaction("indent", it.id)}><ArrowRight class="size-3.5" /></button>
            {#if depth > 1}
              <button type="button" class="rounded p-1 hover:bg-accent" aria-label="Move out one level" onclick={() => onaction("outdent", it.id)}><ArrowLeft class="size-3.5" /></button>
            {/if}
            {#if addable.length === 1}
              <button
                type="button"
                class="rounded p-1 hover:bg-accent"
                aria-label={`Add ${nodeLabel(def, addable[0] ?? "")} inside`}
                onclick={() => onadd(it.id, addable[0] ?? "")}><Plus class="size-3.5" /></button
              >
            {:else if addable.length > 1}
              <select
                class="h-6 rounded border bg-transparent px-1 text-xs"
                aria-label="Add inside"
                onchange={(e) => {
                  const el = e.currentTarget as HTMLSelectElement;
                  if (el.value) onadd(it.id, el.value);
                  el.value = "";
                }}
              >
                <option value="">+ inside…</option>
                {#each addable as k (k)}<option value={k}>{nodeLabel(def, k)}</option>{/each}
              </select>
            {/if}
            <button type="button" class="rounded p-1 text-destructive hover:bg-accent" aria-label="Remove entry" onclick={() => onaction("remove", it.id)}><Trash2 class="size-3.5" /></button>
          </div>
        {/if}
      </div>
      {#if kids.allow.length > 0}
        <Self
          {def}
          {tree}
          items={it.children}
          parentId={it.id}
          depth={depth + 1}
          {selectedId}
          {readOnly}
          {dragging}
          {onselect}
          {onlevel}
          {ondragstart}
          {onaction}
          {onadd}
        />
      {/if}
    </li>
  {/each}
</ul>
