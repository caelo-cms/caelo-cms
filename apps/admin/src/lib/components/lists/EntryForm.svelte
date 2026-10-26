<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * The form of the selected entry (epic #1107): one generated input per
   * field of the entry's node kind, and — for an entry filled from a
   * source — what fills it (query knobs + preview, a system source, a
   * plugin source).
   */

  import type { ListTypeDef } from "@caelo-cms/shared";
  import type { FieldEditorContext } from "#lib/lists/field-context.js";
  import type { EditorItem } from "#lib/lists/tree.js";
  import FieldInput from "./FieldInput.svelte";
  import QueryKnobs from "./QueryKnobs.svelte";

  interface Props {
    def: ListTypeDef;
    item: EditorItem;
    ctx: FieldEditorContext;
    pageTypes: readonly { slug: string; name: string; properties: readonly { name: string; label: string }[] }[];
    previewAvailable: boolean;
    csrfToken: string;
    onvalue: (name: string, value: unknown) => void;
    onquery: (query: Record<string, unknown>) => void;
  }
  let { def, item, ctx, pageTypes, previewAvailable, csrfToken, onvalue, onquery }: Props = $props();

  const node = $derived(def.nodes[item.node]);
  const SYSTEM_SOURCE_TEXT: Record<string, string> = {
    breadcrumbs: "the path from the home page to the page being shown",
    children: "the pages directly below the page being shown",
    siblings: "the pages next to the page being shown",
    page_terms: "the categories and tags of the page being shown",
    term_pages: "the pages that share this entry's categories or tags",
  };
</script>

{#if !node}
  <p class="text-sm text-destructive">
    This entry is a "{item.node}", which the list's type no longer defines. Remove it, or add the
    kind back under Structure.
  </p>
{:else}
  <div class="space-y-4" data-testid="entry-form">
    <p class="text-sm font-medium">{node.label}</p>
    {#if node.fields.length === 0 && !node.source}
      <p class="text-sm text-muted-foreground">This kind of entry has no fields (e.g. a separator).</p>
    {/if}
    {#each node.fields as f (f.name)}
      <FieldInput
        field={f}
        value={item.values[f.name]}
        {ctx}
        idPrefix={`entry-${item.id}`}
        onchange={(v) => onvalue(f.name, v)}
      />
    {/each}
    {#if node.source?.kind === "query"}
      <QueryKnobs
        source={node.source}
        node={item.node}
        query={item.query}
        {ctx}
        {pageTypes}
        {previewAvailable}
        {csrfToken}
        idPrefix={`entry-${item.id}`}
        onchange={onquery}
      />
    {:else if node.source?.kind === "system"}
      <p class="rounded-md border p-3 text-sm text-muted-foreground">
        Filled automatically with {SYSTEM_SOURCE_TEXT[node.source.name] ?? node.source.name}.
      </p>
    {:else if node.source?.kind === "plugin"}
      <p class="rounded-md border p-3 text-sm text-muted-foreground">
        Filled automatically by a plugin ("{node.source.name}"). It shows nothing while that plugin
        is not active.
      </p>
    {/if}
  </div>
{/if}
