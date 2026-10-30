<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Page settings: what the page IS (epic #1107, docs/lists.md §5) — its
   * page type, the type's properties and its categories / tags. Switching
   * the type offers only the templates the new type allows. One save sends
   * type, template, properties and terms to `pages.update`, which checks
   * them against the type. #1276: a save always names the type, so it
   * also confirms a type nobody chose (the old stored default type).
   */

  import type { PageTypeDef } from "@caelo-cms/shared";
  import { untrack } from "svelte";
  import { enhance } from "$app/forms";
  import { Button } from "#lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Select } from "#lib/components/ui/select/index.js";
  import type { FieldEditorContext } from "#lib/lists/field-context.js";
  import { pageSettingsPayload } from "#lib/lists/page-settings.js";
  import FieldInput from "./FieldInput.svelte";
  import TermFieldInput from "./fields/TermFieldInput.svelte";

  interface Props {
    page: {
      pageType: string;
      /** #1276 — false while nobody chose this page's type. */
      pageTypeConfirmed?: boolean;
      templateId: string;
      properties: Record<string, unknown>;
      terms: string[];
      version: number;
    };
    pageTypes: readonly (PageTypeDef & { id: string })[];
    templates: readonly { id: string; displayName: string }[];
    ctx: FieldEditorContext;
    csrfToken: string;
  }
  let { page, pageTypes, templates, ctx, csrfToken }: Props = $props();

  let typeSlug = $state(untrack(() => page.pageType));
  let templateId = $state(untrack(() => page.templateId));
  let properties = $state<Record<string, unknown>>(untrack(() => ({ ...page.properties })));
  let terms = $state<string[]>(untrack(() => [...page.terms]));
  let loadedVersion = $state(untrack(() => page.version));
  $effect(() => {
    if (page.version !== loadedVersion) {
      loadedVersion = page.version;
      typeSlug = page.pageType;
      templateId = page.templateId;
      properties = { ...page.properties };
      terms = [...page.terms];
    }
  });

  const type = $derived(pageTypes.find((t) => t.slug === typeSlug));
  const allowedTemplates = $derived(templates.filter((t) => type?.templates.includes(t.id)));
  $effect(() => {
    // A template the new type does not allow is replaced by its default.
    if (type && !type.templates.includes(templateId)) templateId = type.defaultTemplate;
  });

  function termsOf(listId: string): string[] {
    return terms.filter((t) => t.startsWith(`caelo:term/${listId}/`));
  }
  function setTermsOf(listId: string, next: string[]): void {
    terms = [...terms.filter((t) => !t.startsWith(`caelo:term/${listId}/`)), ...next];
  }
</script>

<Card data-testid="page-type-settings">
  <CardHeader>
    <CardTitle class="text-base">Page type</CardTitle>
    <CardDescription>
      What this page is. The type decides its properties and categories, and which templates it can use.
    </CardDescription>
  </CardHeader>
  <CardContent>
    <form
      method="post"
      action="?/setPageType"
      class="space-y-4"
      use:enhance={({ formData }) => {
        if (!type) return;
        const payload = pageSettingsPayload(type, { properties, terms }, page);
        formData.set("pageType", typeSlug);
        formData.set("templateId", templateId);
        formData.set("properties", JSON.stringify(payload.properties));
        formData.set("terms", JSON.stringify(payload.terms));
        return async ({ update }) => {
          await update({ reset: false });
        };
      }}
    >
      <input type="hidden" name="_csrf" value={csrfToken} />
      <input type="hidden" name="expectedVersion" value={page.version} />
      <div class="grid gap-4 md:grid-cols-2">
        <div class="space-y-1">
          <Label for="page-type">Type</Label>
          <Select id="page-type" bind:value={typeSlug} disabled={ctx.readOnly}>
            {#each pageTypes as t (t.id)}<option value={t.slug}>{t.name}</option>{/each}
          </Select>
          {#if type}<p class="text-xs text-muted-foreground">{type.purpose}</p>{/if}
          {#if page.pageTypeConfirmed === false}
            <p class="text-xs text-amber-700 dark:text-amber-300" data-testid="page-type-unconfirmed">
              Nobody has chosen this page's type yet — pick the one that fits and save.
            </p>
          {/if}
        </div>
        <div class="space-y-1">
          <Label for="page-type-template">Template</Label>
          <Select id="page-type-template" bind:value={templateId} disabled={ctx.readOnly}>
            {#each allowedTemplates as t (t.id)}<option value={t.id}>{t.displayName}</option>{/each}
          </Select>
        </div>
      </div>
      {#if type}
        {#each type.properties as f (f.name)}
          <FieldInput
            field={f}
            value={properties[f.name]}
            {ctx}
            idPrefix="page-prop"
            onchange={(v) => (properties = { ...properties, [f.name]: v })}
          />
        {/each}
        {#each type.vocabularies as v (v.list)}
          {@const vocab = ctx.vocabularies.find((x) => x.id === v.list)}
          <div class="space-y-1" data-testid={`page-terms-${vocab?.slug ?? v.list}`}>
            <Label for={`page-terms-${v.list}`}>
              {vocab?.name ?? "Vocabulary"}{#if v.required}<span class="text-destructive" aria-hidden="true"> *</span>{/if}
            </Label>
            <TermFieldInput
              id={`page-terms-${v.list}`}
              vocabulary={vocab}
              vocabularyName={v.list}
              multiple={v.cardinality === "many"}
              required={v.required === true}
              value={termsOf(v.list)}
              disabled={ctx.readOnly}
              onchange={(next) => setTermsOf(v.list, next as string[])}
            />
          </div>
        {/each}
      {/if}
      {#if !ctx.readOnly}
        <Button type="submit" data-testid="save-page-type-settings">Save page type</Button>
      {/if}
    </form>
  </CardContent>
</Card>
