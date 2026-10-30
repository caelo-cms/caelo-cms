<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * The editor of one page type (epic #1107, docs/lists.md §5): what a page
   * of this kind carries (properties), which categories / tags apply
   * (vocabularies) and which templates it may use. Same save flow as list
   * types: a stale write asks for a reload, a change that would delete
   * stored property values or terms asks before resending with
   * `dropValues`. Read-only without `content.structure`.
   */

  import { LIST_FIELD_TYPES, type PageTypeDef } from "@caelo-cms/shared";
  import { Trash2 } from "lucide-svelte";
  import { untrack } from "svelte";
  import { enhance } from "$app/forms";
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
  import { Select } from "#lib/components/ui/select/index.js";
  import { Textarea } from "#lib/components/ui/textarea/index.js";
  import type { FieldEditorContext } from "#lib/lists/field-context.js";
  import { pageTypeIssues } from "#lib/lists/type-editor.js";
  import ConflictDialog from "./ConflictDialog.svelte";
  import DropValuesDialog from "./DropValuesDialog.svelte";
  import FieldsEditor from "./FieldsEditor.svelte";

  interface Props {
    definition: PageTypeDef;
    version: number;
    templates: readonly { id: string; displayName: string }[];
    ctx: FieldEditorContext;
    csrfToken: string;
    form: Record<string, unknown> | null | undefined;
    note: string;
  }
  let { definition, version, templates, ctx, csrfToken, form, note }: Props = $props();

  /** Page properties cannot embed modules — the module is placed on the page instead. */
  const PROPERTY_TYPES = LIST_FIELD_TYPES.filter((t) => t !== "module");

  // Seeded by the version effect below; untracked so editing never re-reads the prop.
  let def = $state<PageTypeDef>(untrack(() => structuredClone(definition)));
  let loadedVersion = $state(0);
  let dirty = $state(false);
  $effect(() => {
    if (version !== loadedVersion) {
      loadedVersion = version;
      def = structuredClone(definition);
      dirty = false;
    }
  });
  const ro = $derived(ctx.readOnly);
  const issues = $derived(pageTypeIssues(def));
  const savedProps = $derived(new Set(definition.properties.map((p) => p.name)));
  const unusedVocabularies = $derived(ctx.vocabularies.filter((v) => !def.vocabularies.some((x) => x.list === v.id)));

  function edit(next: PageTypeDef): void {
    def = next;
    dirty = true;
  }
  function toggleTemplate(id: string, on: boolean): void {
    const templatesNext = on ? [...def.templates, id] : def.templates.filter((t) => t !== id);
    const defaultTemplate = templatesNext.includes(def.defaultTemplate)
      ? def.defaultTemplate
      : (templatesNext[0] ?? def.defaultTemplate);
    edit({ ...def, templates: templatesNext, defaultTemplate });
  }

  let conflict = $state<string | null>(null);
  let dropPrompt = $state<string | null>(null);
  $effect(() => {
    if (typeof form?.conflict === "string") conflict = form.conflict;
    if (typeof form?.dropValuesRequired === "string") dropPrompt = form.dropValuesRequired;
  });
  let formEl = $state<HTMLFormElement | null>(null);
  let dropValues = $state(false);
</script>

<ConflictDialog message={conflict} what="This page type" onclose={() => (conflict = null)} />
<DropValuesDialog
  message={dropPrompt}
  onconfirm={() => {
    dropPrompt = null;
    dropValues = true;
    formEl?.requestSubmit();
  }}
  onclose={() => (dropPrompt = null)}
/>

<div class="space-y-6" data-testid="page-type-editor">
  {#if ro}
    <Alert>
      <AlertDescription>Read-only: changing page types needs the "content.structure" permission.</AlertDescription>
    </Alert>
  {/if}
  <Card>
    <CardHeader>
      <CardTitle class="text-base">{def.name}</CardTitle>
      <CardDescription>{note}</CardDescription>
    </CardHeader>
    <CardContent class="grid gap-4 md:grid-cols-2">
      <div class="space-y-1">
        <Label for="pt-name">Name</Label>
        <Input id="pt-name" value={def.name} disabled={ro} oninput={(e) => edit({ ...def, name: (e.currentTarget as HTMLInputElement).value })} />
      </div>
      <div class="space-y-1">
        <Label for="pt-default">Template for new pages</Label>
        <Select id="pt-default" value={def.defaultTemplate} disabled={ro} onchange={(e: Event) => edit({ ...def, defaultTemplate: (e.currentTarget as HTMLSelectElement).value })}>
          {#each templates.filter((t) => def.templates.includes(t.id)) as t (t.id)}<option value={t.id}>{t.displayName}</option>{/each}
        </Select>
      </div>
      <div class="space-y-1 md:col-span-2">
        <Label for="pt-purpose">What pages of this type are</Label>
        <Textarea id="pt-purpose" value={def.purpose} disabled={ro} oninput={(e) => edit({ ...def, purpose: (e.currentTarget as HTMLTextAreaElement).value })} />
      </div>
      <div class="space-y-1 md:col-span-2">
        <Label for="pt-collection">Kind of pages</Label>
        <Select id="pt-collection" value={String(def.collection)} disabled={ro} onchange={(e: Event) => edit({ ...def, collection: (e.currentTarget as HTMLSelectElement).value === "true" })}>
          <option value="true">Many similar pages, listed together (blog posts, news, products, jobs, docs)</option>
          <option value="false">Standalone pages (home, about, contact, legal, landing)</option>
        </Select>
      </div>
      <fieldset class="space-y-1 md:col-span-2">
        <legend class="text-sm font-medium">Templates pages of this type may use</legend>
        <div class="flex flex-wrap gap-x-4 gap-y-1">
          {#each templates as t (t.id)}
            <label class="inline-flex items-center gap-1 text-sm">
              <input type="checkbox" checked={def.templates.includes(t.id)} disabled={ro} onchange={(e) => toggleTemplate(t.id, (e.currentTarget as HTMLInputElement).checked)} />
              {t.displayName}
            </label>
          {/each}
        </div>
      </fieldset>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Properties</CardTitle>
      <CardDescription>What every page of this type carries besides its content (a date, an author, a price …).</CardDescription>
    </CardHeader>
    <CardContent>
      <FieldsEditor
        fields={def.properties}
        savedNames={savedProps}
        types={PROPERTY_TYPES}
        {ctx}
        idPrefix="pt-prop"
        addLabel="Add property"
        onchange={(properties) => edit({ ...def, properties })}
      />
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Categories and tags</CardTitle>
      <CardDescription>Vocabularies whose entries a page of this type can carry.</CardDescription>
    </CardHeader>
    <CardContent class="space-y-2">
      {#each def.vocabularies as v, i (v.list)}
        {@const vocab = ctx.vocabularies.find((x) => x.id === v.list)}
        <div class="flex flex-wrap items-center gap-3 rounded-md border p-2 text-sm" data-testid="page-type-vocabulary">
          <span class="min-w-32 font-medium">{vocab?.name ?? "(missing list)"}</span>
          <Select class="h-8 w-auto" value={v.cardinality} disabled={ro} aria-label="How many" onchange={(e: Event) => edit({ ...def, vocabularies: def.vocabularies.map((x, k) => (k === i ? { ...x, cardinality: (e.currentTarget as HTMLSelectElement).value as "one" | "many" } : x)) })}>
            <option value="one">One per page</option>
            <option value="many">Several per page</option>
          </Select>
          <label class="inline-flex items-center gap-1">
            <input type="checkbox" checked={v.required === true} disabled={ro} onchange={(e) => {
              const on = (e.currentTarget as HTMLInputElement).checked;
              edit({ ...def, vocabularies: def.vocabularies.map((x, k) => {
                if (k !== i) return x;
                const { required: _r, ...rest } = x;
                return on ? { ...rest, required: true } : rest;
              }) });
            }} />
            Required
          </label>
          {#if !ro}
            <button type="button" class="ml-auto rounded p-1 text-destructive hover:bg-accent" aria-label="Remove vocabulary" onclick={() => edit({ ...def, vocabularies: def.vocabularies.filter((_, k) => k !== i) })}><Trash2 class="size-3.5" /></button>
          {/if}
        </div>
      {/each}
      {#if !ro && unusedVocabularies.length > 0}
        <Select
          class="w-auto"
          aria-label="Add a vocabulary"
          value=""
          onchange={(e: Event) => {
            const el = e.currentTarget as HTMLSelectElement;
            if (el.value) edit({ ...def, vocabularies: [...def.vocabularies, { list: el.value, cardinality: "many" }] });
            el.value = "";
          }}
        >
          <option value="">Add categories or tags…</option>
          {#each unusedVocabularies as v (v.id)}<option value={v.id}>{v.name}</option>{/each}
        </Select>
      {/if}
    </CardContent>
  </Card>

  {#if issues.length > 0}
    <Alert variant="destructive">
      <AlertDescription>
        <ul class="list-disc pl-4">
          {#each issues as i (`${i.path}:${i.message}`)}<li>{i.path ? `${i.path}: ` : ""}{i.message}</li>{/each}
        </ul>
      </AlertDescription>
    </Alert>
  {/if}

  {#if !ro}
    <form
      method="post"
      action="?/save"
      bind:this={formEl}
      use:enhance={({ formData }) => {
        formData.set("definition", JSON.stringify(def));
        if (dropValues) formData.set("dropValues", "true");
        dropValues = false;
        return async ({ update }) => {
          await update({ reset: false });
        };
      }}
    >
      <input type="hidden" name="_csrf" value={csrfToken} />
      <input type="hidden" name="expectedVersion" value={version} />
      <Button type="submit" disabled={!dirty || issues.length > 0} data-testid="save-page-type">Save page type</Button>
    </form>
  {/if}
</div>
