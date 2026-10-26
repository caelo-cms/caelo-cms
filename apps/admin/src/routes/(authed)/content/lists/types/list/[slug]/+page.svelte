<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { enhance } from "$app/forms";
  import { confirmSubmit } from "#lib/confirm.svelte.js";
  import AreaHeader from "#lib/components/lists/AreaHeader.svelte";
  import TypeEditor from "#lib/components/lists/TypeEditor.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import type { FieldEditorContext } from "#lib/lists/field-context.js";

  let { data, form } = $props();
  const sharedNote = $derived(
    data.lists.length === 0 && data.localLists.length === 0
      ? "No list uses this type yet."
      : `Used by ${data.lists.length} list${data.lists.length === 1 ? "" : "s"}${data.lists.length > 0 ? ` (${data.lists.slice(0, 4).map((l) => l.name).join(", ")}${data.lists.length > 4 ? ", …" : ""})` : ""}${data.localLists.length > 0 ? ` and ${data.localLists.length} inside sections` : ""}.`,
  );
  const ctx: FieldEditorContext = $derived({
    pages: data.pages,
    modules: [],
    vocabularies: data.vocabularies,
    readOnly: !data.canStructure,
  });
</script>

<div class="space-y-6">
  <AreaHeader active="types" description="Edit a list type. Every list of the type follows the change." />
  <TypeEditor
    definition={data.listType.definition}
    version={data.listType.version}
    {ctx}
    csrfToken={data.csrfToken}
    form={form as Record<string, unknown> | null}
    {sharedNote}
  />
  {#if data.canStructure}
    <form
      method="post"
      action="?/delete"
      use:enhance
      use:confirmSubmit={{ title: `Delete the list type "${data.listType.name}"?`, description: "Only possible while no list uses it.", confirmLabel: "Delete type" }}
    >
      <input type="hidden" name="_csrf" value={data.csrfToken} />
      <Button type="submit" variant="destructive">Delete list type</Button>
    </form>
  {/if}
</div>
