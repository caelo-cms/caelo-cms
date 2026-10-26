<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * `term` field and page terms (epic #1107): entries of a vocabulary list
   * (categories, tags). One term → a select; several → checkboxes. The
   * value is the array of `caelo:term/<listId>/<itemId>` references.
   */
  import { Select } from "#lib/components/ui/select/index.js";
  import { type VocabularyChoice, termChoices } from "#lib/lists/field-context.js";

  interface Props {
    id: string;
    vocabulary: VocabularyChoice | undefined;
    /** Name of the vocabulary as the definition gives it, for the missing case. */
    vocabularyName: string;
    multiple: boolean;
    required: boolean;
    value: unknown;
    disabled: boolean;
    onchange: (v: unknown) => void;
  }
  let { id, vocabulary, vocabularyName, multiple, required, value, disabled, onchange }: Props =
    $props();

  const selected = $derived(
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [],
  );
  const choices = $derived(vocabulary ? termChoices(vocabulary) : []);

  function toggle(ref: string, on: boolean): void {
    onchange(on ? [...selected, ref] : selected.filter((r) => r !== ref));
  }
</script>

{#if !vocabulary}
  <p class="text-sm text-destructive">
    The vocabulary "{vocabularyName}" does not exist — create it under Menus &amp; lists or fix the
    type.
  </p>
{:else if choices.length === 0}
  <p class="text-sm text-muted-foreground">
    {vocabulary.name} has no entries yet —
    <a class="underline" href={`/content/lists/${vocabulary.slug}`}>add some</a>.
  </p>
{:else if multiple}
  <fieldset {id} class="flex flex-wrap gap-x-4 gap-y-1" aria-label={vocabulary.name}>
    {#each choices as c (c.ref)}
      <label class="inline-flex items-center gap-1 text-sm" style:padding-left={`${(c.depth - 1) * 0.75}rem`}>
        <input
          type="checkbox"
          checked={selected.includes(c.ref)}
          {disabled}
          onchange={(e) => toggle(c.ref, (e.currentTarget as HTMLInputElement).checked)}
        />
        {c.name}
      </label>
    {/each}
  </fieldset>
{:else}
  <Select
    {id}
    value={selected[0] ?? ""}
    {required}
    {disabled}
    onchange={(e: Event) => {
      const v = (e.currentTarget as HTMLSelectElement).value;
      onchange(v ? [v] : []);
    }}
  >
    <option value="">—</option>
    {#each choices as c (c.ref)}
      <option value={c.ref}>{"  ".repeat(c.depth - 1)}{c.name}</option>
    {/each}
  </Select>
{/if}
