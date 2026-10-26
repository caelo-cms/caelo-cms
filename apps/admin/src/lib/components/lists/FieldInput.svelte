<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * One generated form input for a field definition (epic #1107): list
   * entry fields and page properties alike. Picks the component for the
   * field's widget (`field-form.ts`) and shows the value's problems inline,
   * the same messages the server would refuse with.
   */

  import type { FieldDef } from "@caelo-cms/shared";
  import { Label } from "#lib/components/ui/label/index.js";
  import type { FieldEditorContext } from "#lib/lists/field-context.js";
  import { fieldInputSpec, fieldProblems } from "#lib/lists/field-form.js";
  import BooleanFieldInput from "./fields/BooleanFieldInput.svelte";
  import DateFieldInput from "./fields/DateFieldInput.svelte";
  import IconFieldInput from "./fields/IconFieldInput.svelte";
  import LinkFieldInput from "./fields/LinkFieldInput.svelte";
  import MediaFieldInput from "./fields/MediaFieldInput.svelte";
  import ModuleFieldInput from "./fields/ModuleFieldInput.svelte";
  import NumberFieldInput from "./fields/NumberFieldInput.svelte";
  import RichtextFieldInput from "./fields/RichtextFieldInput.svelte";
  import SelectFieldInput from "./fields/SelectFieldInput.svelte";
  import TermFieldInput from "./fields/TermFieldInput.svelte";
  import TextFieldInput from "./fields/TextFieldInput.svelte";

  interface Props {
    field: FieldDef;
    value: unknown;
    ctx: FieldEditorContext;
    /** Prefix for the input id (unique per form). */
    idPrefix: string;
    /** Show problems only once the operator has touched the form. */
    showProblems?: boolean;
    onchange: (v: unknown) => void;
  }
  let { field, value, ctx, idPrefix, showProblems = true, onchange }: Props = $props();

  const spec = $derived(fieldInputSpec(field));
  const id = $derived(`${idPrefix}-${field.name}`);
  const problems = $derived(showProblems ? fieldProblems(field, value) : []);
  const disabled = $derived(ctx.readOnly);
</script>

<div class="space-y-1" data-testid={`field-${field.name}`}>
  <Label for={id}>
    {field.label}{#if spec.required}<span class="text-destructive" aria-hidden="true"> *</span>{/if}
  </Label>
  {#if spec.widget === "text"}
    <TextFieldInput {id} {spec} {value} {disabled} {onchange} />
  {:else if spec.widget === "richtext"}
    <RichtextFieldInput {id} {spec} {value} {disabled} {onchange} />
  {:else if spec.widget === "link"}
    <LinkFieldInput {id} {spec} {value} {disabled} {ctx} {onchange} />
  {:else if spec.widget === "media"}
    <MediaFieldInput {id} {value} {disabled} {onchange} />
  {:else if spec.widget === "select"}
    <SelectFieldInput {id} {spec} {value} {disabled} {onchange} />
  {:else if spec.widget === "boolean"}
    <BooleanFieldInput {id} {value} {disabled} {onchange} />
  {:else if spec.widget === "number"}
    <NumberFieldInput {id} {spec} {value} {disabled} {onchange} />
  {:else if spec.widget === "date"}
    <DateFieldInput {id} {spec} {value} {disabled} {onchange} />
  {:else if spec.widget === "icon"}
    <IconFieldInput {id} {spec} {value} {disabled} {onchange} />
  {:else if spec.widget === "module"}
    <ModuleFieldInput {id} {spec} {value} {disabled} {ctx} {onchange} />
  {:else if spec.widget === "term"}
    <TermFieldInput
      {id}
      vocabulary={ctx.vocabularies.find((v) => v.slug === spec.vocabulary)}
      vocabularyName={spec.vocabulary ?? ""}
      multiple={spec.multiple === true}
      required={spec.required}
      {value}
      {disabled}
      {onchange}
    />
  {/if}
  {#each problems as p (p)}
    <p class="text-xs text-destructive">{p}</p>
  {/each}
</div>
