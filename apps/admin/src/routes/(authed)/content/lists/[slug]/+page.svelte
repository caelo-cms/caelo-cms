<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { applyAction, deserialize, enhance } from "$app/forms";
  import { confirmSubmit } from "#lib/confirm.svelte.js";
  import ConflictDialog from "#lib/components/lists/ConflictDialog.svelte";
  import EntryForm from "#lib/components/lists/EntryForm.svelte";
  import ListTreeLevel from "#lib/components/lists/ListTreeLevel.svelte";
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
  import { Textarea } from "#lib/components/ui/textarea/index.js";
  import type { FieldEditorContext } from "#lib/lists/field-context.js";
  import {
    addableKinds,
    countItems,
    type EditorItem,
    findItem,
    fromStored,
    indentItem,
    insertItem,
    newItem,
    nodeLabel,
    outdentItem,
    removeItem,
    replaceLevel,
    shiftItem,
    structureIssues,
    toSavedItems,
    updateItem,
  } from "#lib/lists/tree.js";
  import { usageSummary } from "#lib/lists/usage.js";

  let { data, form } = $props();

  const def = $derived(data.listType.definition);
  const readOnly = $derived(!data.canWrite);

  // The editor's working copy. It is reset from the server only when the
  // stored version changes (after a save or a reload), never while editing.
  let tree = $state<EditorItem[]>([]);
  let name = $state("");
  let purpose = $state("");
  let loadedVersion = $state(0);
  let dirty = $state(false);
  let selectedId = $state<string | null>(null);
  let notice = $state<string | null>(null);
  $effect(() => {
    if (data.list.version !== loadedVersion) {
      loadedVersion = data.list.version;
      tree = fromStored(data.list.items);
      name = data.list.name;
      purpose = data.list.purpose;
      dirty = false;
    }
  });

  let conflict = $state<string | null>(null);
  $effect(() => {
    const f = form as { conflict?: string } | null;
    if (f?.conflict) conflict = f.conflict;
  });

  const selected = $derived(selectedId ? findItem(tree, selectedId) : null);
  const rootKinds = $derived(readOnly ? [] : addableKinds(def, tree, null));

  function change(next: EditorItem[]): void {
    tree = next;
    dirty = true;
    notice = null;
  }

  function apply(r: { items: EditorItem[]; check: { ok: boolean; reason?: string } }): void {
    if (r.check.ok) change(r.items);
    else notice = r.check.reason ?? null;
  }

  function onaction(action: "up" | "down" | "indent" | "outdent" | "remove", id: string): void {
    if (action === "up") apply(shiftItem(def, tree, id, -1));
    else if (action === "down") apply(shiftItem(def, tree, id, 1));
    else if (action === "indent") apply(indentItem(def, tree, id));
    else if (action === "outdent") apply(outdentItem(def, tree, id));
    else {
      change(removeItem(tree, id));
      if (selectedId === id) selectedId = null;
    }
  }

  function onadd(parentId: string | null, node: string): void {
    const item = newItem(def, node);
    change(insertItem(tree, item, parentId));
    selectedId = item.id;
  }

  // Drag and drop: the tree as it was when the drag started, restored when
  // the drop broke a rule the levels could not refuse up front.
  let dragging = $state<EditorItem | null>(null);
  let beforeDrag: EditorItem[] | null = null;
  function ondragstart(id: string): void {
    beforeDrag = tree;
    dragging = findItem(tree, id);
  }
  function onlevel(parentId: string | null, items: EditorItem[], final: boolean): void {
    tree = replaceLevel(tree, parentId, items);
    if (!final) return;
    // Both levels of a cross-level move finalize; check once the drag is over.
    queueMicrotask(() => {
      if (!dragging) return;
      const issues = structureIssues(def, tree);
      if (issues.length > 0 && beforeDrag) {
        tree = beforeDrag;
        notice = issues[0] ?? null;
      } else {
        dirty = true;
        notice = null;
      }
      dragging = null;
      beforeDrag = null;
    });
  }

  async function createInstance(moduleId: string): Promise<string | null> {
    const body = new FormData();
    body.set("_csrf", data.csrfToken);
    body.set("moduleId", moduleId);
    const res = await fetch("?/createInstance", {
      method: "POST",
      body,
      headers: { "x-sveltekit-action": "true" },
    });
    const result = deserialize(await res.text());
    if (result.type === "success") {
      return (result.data as { contentInstanceId?: string }).contentInstanceId ?? null;
    }
    // A refusal goes through the page form so the layout shows it.
    await applyAction(result);
    return null;
  }

  const ctx: FieldEditorContext = $derived({
    pages: data.pages,
    modules: data.modules,
    vocabularies: data.vocabularies,
    readOnly,
    createInstance,
  });
</script>

<ConflictDialog message={conflict} what="This list" onclose={() => (conflict = null)} />

<div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
  <Card>
    <CardHeader>
      <CardTitle class="text-base">Entries</CardTitle>
      <CardDescription>
        {countItems(tree)} entr{countItems(tree) === 1 ? "y" : "ies"}. Drag to reorder or nest, or use the
        arrows; select an entry to edit it.
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-3">
      {#if notice}
        <Alert data-testid="tree-notice"><AlertDescription>{notice}</AlertDescription></Alert>
      {/if}
      {#if tree.length === 0}
        <p class="text-sm text-muted-foreground">No entries yet.</p>
      {/if}
      <ListTreeLevel
        {def}
        {tree}
        items={tree}
        parentId={null}
        depth={1}
        {selectedId}
        {readOnly}
        {dragging}
        onselect={(id) => (selectedId = id)}
        {onlevel}
        {ondragstart}
        {onaction}
        {onadd}
      />
      {#if rootKinds.length > 0}
        <div class="flex flex-wrap gap-2">
          {#each rootKinds as k (k)}
            <Button type="button" variant="outline" size="sm" onclick={() => onadd(null, k)}
              >Add {nodeLabel(def, k).toLowerCase()}</Button
            >
          {/each}
        </div>
      {/if}
    </CardContent>
  </Card>

  <div class="space-y-6">
    <Card>
      <CardContent class="pt-6">
        {#if selected}
          <EntryForm
            {def}
            item={selected}
            {ctx}
            pageTypes={data.pageTypes}
            previewAvailable={data.previewAvailable}
            csrfToken={data.csrfToken}
            onvalue={(fieldName, v) =>
              change(
                updateItem(tree, selected.id, (it) => ({
                  ...it,
                  values: { ...it.values, [fieldName]: v },
                })),
              )}
            onquery={(query) => change(updateItem(tree, selected.id, (it) => ({ ...it, query })))}
          />
        {:else}
          <p class="text-sm text-muted-foreground">Select an entry to edit it.</p>
        {/if}
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle class="text-base">About this list</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          method="post"
          action="?/save"
          class="space-y-4"
          use:enhance={({ formData }) => {
            formData.set("items", JSON.stringify(toSavedItems(def, tree)));
            return async ({ update }) => {
              await update({ reset: false });
            };
          }}
        >
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <input type="hidden" name="expectedVersion" value={data.list.version} />
          <div class="space-y-2">
            <Label for="list-name">Name</Label>
            <Input id="list-name" name="name" bind:value={name} oninput={() => (dirty = true)} disabled={readOnly} required />
          </div>
          <div class="space-y-2">
            <Label for="list-purpose">What it is for</Label>
            <Textarea id="list-purpose" name="purpose" bind:value={purpose} oninput={() => (dirty = true)} disabled={readOnly} required />
          </div>
          <p class="text-sm text-muted-foreground" data-testid="list-used-in">
            Used in: {usageSummary(data.list.usage)}
            {#if data.list.usage.samplePages.length > 0}
              — {data.list.usage.samplePages.map((p) => p.path).join(", ")}
            {/if}
          </p>
          {#if !readOnly}
            <div class="flex items-center gap-3">
              <Button type="submit" data-testid="save-list" disabled={!dirty}>Save list</Button>
              {#if dirty}<span class="text-sm text-muted-foreground">Unsaved changes</span>{/if}
            </div>
          {/if}
        </form>
      </CardContent>
    </Card>

    {#if !readOnly}
      <Card class="border-destructive/50">
        <CardHeader>
          <CardTitle class="text-base text-destructive">Delete list</CardTitle>
          <CardDescription>
            A list that a section still shows cannot be deleted — remove it from those sections first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            method="post"
            action="?/delete"
            use:enhance
            use:confirmSubmit={{
              title: `Delete the list "${data.list.name}"?`,
              description: "Its entries are removed. You can undo this from the history.",
              confirmLabel: "Delete list",
            }}
          >
            <input type="hidden" name="_csrf" value={data.csrfToken} />
            <Button type="submit" variant="destructive" data-testid="delete-list">Delete list</Button>
          </form>
        </CardContent>
      </Card>
    {/if}
  </div>
</div>
