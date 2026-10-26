<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { enhance } from "$app/forms";
  import { confirmSubmit } from "#lib/confirm.svelte.js";
  import AreaHeader from "#lib/components/lists/AreaHeader.svelte";
  import PageTypeEditor from "#lib/components/lists/PageTypeEditor.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import type { FieldEditorContext } from "#lib/lists/field-context.js";

  let { data, form } = $props();
  const note = $derived(
    data.pageCount === 0
      ? "No page has this type yet."
      : `${data.pageCount} page${data.pageCount === 1 ? "" : "s"} of this type${data.samplePages.length > 0 ? `, e.g. ${data.samplePages.map((p) => p.path).join(", ")}` : ""}.`,
  );
  const ctx: FieldEditorContext = $derived({
    pages: data.pages,
    modules: [],
    vocabularies: data.vocabularies,
    readOnly: !data.canStructure,
  });
</script>

<div class="space-y-6">
  <AreaHeader active="types" description="Edit a page type. Every page of the type follows the change." />
  <PageTypeEditor
    definition={data.definition}
    version={data.version}
    templates={data.templates}
    {ctx}
    csrfToken={data.csrfToken}
    form={form as Record<string, unknown> | null}
    {note}
  />
  {#if data.canStructure}
    <form
      method="post"
      action="?/delete"
      use:enhance
      use:confirmSubmit={{ title: `Delete the page type "${data.definition.name}"?`, description: "Only possible while no page has this type.", confirmLabel: "Delete type" }}
    >
      <input type="hidden" name="_csrf" value={data.csrfToken} />
      <Button type="submit" variant="destructive">Delete page type</Button>
    </form>
  {/if}
</div>
