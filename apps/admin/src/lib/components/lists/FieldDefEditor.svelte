<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * One field declaration in the Structure / Types editor (epic #1107,
   * docs/lists.md §2). The name of a field that is already saved stays
   * fixed: renaming it would drop every stored value of the old name.
   */

  import { type FieldDef, LIST_FIELD_TYPES, type ListFieldType } from "@caelo-cms/shared";
  import { ArrowDown, ArrowUp, Trash2 } from "lucide-svelte";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Select } from "#lib/components/ui/select/index.js";
  import type { FieldEditorContext } from "#lib/lists/field-context.js";
  import { coerceFieldValue } from "#lib/lists/field-form.js";
  import { withFieldType } from "#lib/lists/type-editor.js";
  import FieldInput from "./FieldInput.svelte";

  interface Props {
    field: FieldDef;
    /** The field already exists in the saved definition. */
    saved: boolean;
    /** Field types this definition may use (page properties exclude `module`). */
    types?: readonly ListFieldType[];
    ctx: FieldEditorContext;
    idPrefix: string;
    onchange: (f: FieldDef) => void;
    onmove: (delta: -1 | 1) => void;
    onremove: () => void;
  }
  let {
    field,
    saved,
    types = LIST_FIELD_TYPES,
    ctx,
    idPrefix,
    onchange,
    onmove,
    onremove,
  }: Props = $props();

  const TYPE_LABELS: Record<ListFieldType, string> = {
    text: "Text",
    richtext: "Formatted text",
    link: "Link",
    media: "Image or file",
    select: "Choice",
    boolean: "Yes / no",
    number: "Number",
    date: "Date",
    icon: "Icon name",
    module: "Embedded module",
    term: "Category or tag",
  };
  /** Types whose default the editor can offer (module / term defaults name stored rows). */
  const DEFAULTABLE = new Set<ListFieldType>(["text", "richtext", "link", "select", "boolean", "number", "date", "icon"]);
  const ro = $derived(ctx.readOnly);
  const id = $derived(`${idPrefix}-${field.name}`);

  function patch(p: Record<string, unknown>): void {
    const next: Record<string, unknown> = { ...field, ...p };
    for (const [k, v] of Object.entries(p)) if (v === undefined || v === "") delete next[k];
    onchange(next as FieldDef);
  }
  function csv(s: string): string[] {
    return s.split(",").map((x) => x.trim()).filter(Boolean);
  }
</script>

<div class="space-y-2 rounded-md border p-3" data-testid="field-def">
  <div class="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
    <div class="space-y-1">
      <Label for={`${id}-label`}>Label</Label>
      <Input id={`${id}-label`} value={field.label} disabled={ro} oninput={(e) => patch({ label: (e.currentTarget as HTMLInputElement).value })} />
    </div>
    <div class="space-y-1">
      <Label for={`${id}-name`}>Name in templates</Label>
      <Input
        id={`${id}-name`}
        value={field.name}
        disabled={ro || saved}
        title={saved ? "A saved field keeps its name — renaming would drop its values." : undefined}
        oninput={(e) => patch({ name: (e.currentTarget as HTMLInputElement).value })}
      />
    </div>
    <div class="space-y-1">
      <Label for={`${id}-type`}>Type</Label>
      <Select
        id={`${id}-type`}
        value={field.type}
        disabled={ro}
        onchange={(e: Event) =>
          onchange(withFieldType(field, (e.currentTarget as HTMLSelectElement).value as ListFieldType, {
            vocabularySlugs: ctx.vocabularies.map((v) => v.slug),
          }))}
      >
        {#each types as t (t)}<option value={t}>{TYPE_LABELS[t]}</option>{/each}
      </Select>
    </div>
    {#if !ro}
      <div class="flex items-end gap-1">
        <button type="button" class="rounded p-2 hover:bg-accent" aria-label="Move field up" onclick={() => onmove(-1)}><ArrowUp class="size-3.5" /></button>
        <button type="button" class="rounded p-2 hover:bg-accent" aria-label="Move field down" onclick={() => onmove(1)}><ArrowDown class="size-3.5" /></button>
        <button type="button" class="rounded p-2 text-destructive hover:bg-accent" aria-label="Remove field" onclick={onremove}><Trash2 class="size-3.5" /></button>
      </div>
    {/if}
  </div>
  <div class="flex flex-wrap items-end gap-4 text-sm">
    <label class="inline-flex items-center gap-1">
      <input type="checkbox" checked={field.required === true} disabled={ro} onchange={(e) => patch({ required: (e.currentTarget as HTMLInputElement).checked || undefined })} />
      Required
    </label>
    {#if field.type === "text" || field.type === "richtext"}
      <label class="inline-flex items-center gap-1">
        Max length
        <Input class="h-7 w-24" type="number" min={1} value={field.maxLength ?? ""} disabled={ro} oninput={(e) => {
          const n = Number((e.currentTarget as HTMLInputElement).value);
          patch({ maxLength: Number.isInteger(n) && n > 0 ? n : undefined });
        }} />
      </label>
    {:else if field.type === "select"}
      <label class="inline-flex flex-1 items-center gap-1">
        Options
        <Input class="h-7" value={field.options.join(", ")} disabled={ro} placeholder="small, medium, large" onchange={(e) => patch({ options: csv((e.currentTarget as HTMLInputElement).value) })} />
      </label>
    {:else if field.type === "number"}
      <label class="inline-flex items-center gap-1">Min <Input class="h-7 w-20" type="number" value={field.min ?? ""} disabled={ro} oninput={(e) => { const v = (e.currentTarget as HTMLInputElement).value; patch({ min: v === "" ? undefined : Number(v) }); }} /></label>
      <label class="inline-flex items-center gap-1">Max <Input class="h-7 w-20" type="number" value={field.max ?? ""} disabled={ro} oninput={(e) => { const v = (e.currentTarget as HTMLInputElement).value; patch({ max: v === "" ? undefined : Number(v) }); }} /></label>
    {:else if field.type === "module"}
      <label class="inline-flex flex-1 items-center gap-1">
        Module types allowed
        <Input class="h-7" value={(field.accepts ?? []).join(", ")} disabled={ro} placeholder="any" onchange={(e) => { const v = csv((e.currentTarget as HTMLInputElement).value); patch({ accepts: v.length > 0 ? v : undefined }); }} />
      </label>
    {:else if field.type === "term"}
      <label class="inline-flex items-center gap-1">
        From
        <Select class="h-7" value={field.list} disabled={ro} onchange={(e: Event) => patch({ list: (e.currentTarget as HTMLSelectElement).value })}>
          {#each ctx.vocabularies as v (v.slug)}<option value={v.slug}>{v.name}</option>{/each}
          {#if !ctx.vocabularies.some((v) => v.slug === field.list)}<option value={field.list}>{field.list} (missing)</option>{/if}
        </Select>
      </label>
      <label class="inline-flex items-center gap-1">
        <input type="checkbox" checked={field.multiple === true} disabled={ro} onchange={(e) => patch({ multiple: (e.currentTarget as HTMLInputElement).checked || undefined })} />
        Several
      </label>
    {/if}
  </div>
  {#if DEFAULTABLE.has(field.type)}
    <details class="text-sm" open={field.default !== undefined}>
      <summary class="cursor-pointer text-muted-foreground">Default value{field.required ? " (needed when entries already exist)" : ""}</summary>
      <div class="mt-2">
        <FieldInput
          field={{ ...field, required: false, label: "Default" } as FieldDef}
          value={field.default}
          {ctx}
          idPrefix={`${id}-default`}
          showProblems={false}
          onchange={(v) => patch({ default: coerceFieldValue(field, v) })}
        />
      </div>
    </details>
  {/if}
</div>
