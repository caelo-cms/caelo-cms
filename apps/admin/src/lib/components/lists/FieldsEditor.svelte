<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /** The field list of a node kind or a page type (epic #1107). */

  import { type FieldDef, LIST_FIELD_TYPES, type ListFieldType } from "@caelo-cms/shared";
  import { Button } from "#lib/components/ui/button/index.js";
  import type { FieldEditorContext } from "#lib/lists/field-context.js";
  import { newField } from "#lib/lists/type-editor.js";
  import FieldDefEditor from "./FieldDefEditor.svelte";

  interface Props {
    fields: FieldDef[];
    /** Names of the fields in the saved definition (their names stay fixed). */
    savedNames: ReadonlySet<string>;
    types?: readonly ListFieldType[];
    ctx: FieldEditorContext;
    idPrefix: string;
    addLabel?: string;
    onchange: (fields: FieldDef[]) => void;
  }
  let {
    fields,
    savedNames,
    types = LIST_FIELD_TYPES,
    ctx,
    idPrefix,
    addLabel = "Add field",
    onchange,
  }: Props = $props();

  function move(i: number, delta: -1 | 1): void {
    const j = i + delta;
    if (j < 0 || j >= fields.length) return;
    const next = [...fields];
    [next[i], next[j]] = [next[j] as FieldDef, next[i] as FieldDef];
    onchange(next);
  }
</script>

<div class="space-y-2">
  {#each fields as f, i (i)}
    <FieldDefEditor
      field={f}
      saved={savedNames.has(f.name)}
      {types}
      {ctx}
      idPrefix={`${idPrefix}-${i}`}
      onchange={(nf) => onchange(fields.map((x, k) => (k === i ? nf : x)))}
      onmove={(d) => move(i, d)}
      onremove={() => onchange(fields.filter((_, k) => k !== i))}
    />
  {/each}
  {#if !ctx.readOnly}
    <Button type="button" variant="outline" size="sm" onclick={() => onchange([...fields, newField(fields)])}
      >{addLabel}</Button
    >
  {/if}
</div>
