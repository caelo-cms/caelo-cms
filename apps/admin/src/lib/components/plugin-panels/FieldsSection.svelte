<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * A plugin panel's `form` (blank, submits once) or `settings` (pre-filled
   * from the plugin) section. The browser checks the declared limits for a
   * quick hint; the server validates every value against the same
   * declaration before the plugin sees it.
   */

  import type { PanelField } from "@caelo-cms/plugin-sdk";
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
  import type { FormState, SettingsState } from "#lib/plugin-panels.js";

  interface Props {
    view: FormState | SettingsState;
    csrfToken: string;
  }
  let { view, csrfToken }: Props = $props();

  const section = $derived(view.section);
  const fields = $derived(section.fields as readonly PanelField[]);
  const values = $derived(view.kind === "settings" ? view.values : {});
  const loadError = $derived(view.kind === "settings" ? view.error : null);

  function text(arg: string): string {
    const v = values[arg];
    return v === undefined || v === null ? "" : String(v);
  }
</script>

<Card data-testid="panel-section-{section.id}">
  <CardHeader>
    <CardTitle>{section.title}</CardTitle>
    {#if section.description}
      <CardDescription>{section.description}</CardDescription>
    {/if}
  </CardHeader>
  <CardContent>
    {#if loadError}
      <Alert variant="destructive">
        <AlertDescription>The plugin could not load these settings: {loadError}</AlertDescription>
      </Alert>
    {:else}
      <form
        method="post"
        action={view.kind === "settings" ? "?/settings" : "?/form"}
        use:enhance={() =>
          async ({ update }) => {
            // A one-shot form starts blank again; settings keep what was saved.
            await update({ reset: view.kind === "form" });
          }}
        class="grid max-w-xl gap-4"
      >
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="section" value={section.id} />
        {#each fields as field (field.arg)}
          {@const id = `${section.id}-${field.arg}`}
          {#if field.input === "checkbox"}
            <div class="flex items-start gap-2">
              <input
                {id}
                type="checkbox"
                name={field.arg}
                class="mt-0.5 size-4"
                checked={values[field.arg] === true}
              />
              <div class="grid gap-1">
                <Label for={id}>{field.label}</Label>
                {#if field.description}<p class="text-xs text-muted-foreground">{field.description}</p>{/if}
              </div>
            </div>
          {:else}
            <div class="grid gap-1.5">
              <Label for={id}>{field.label}</Label>
              {#if field.input === "textarea"}
                <Textarea
                  {id}
                  name={field.arg}
                  rows={4}
                  required={field.required}
                  maxlength={field.maxLength}
                  minlength={field.minLength}
                  placeholder={field.placeholder}
                  value={text(field.arg)}
                />
              {:else if field.input === "text"}
                <Input
                  {id}
                  name={field.arg}
                  required={field.required}
                  maxlength={field.maxLength}
                  minlength={field.minLength}
                  placeholder={field.placeholder}
                  value={text(field.arg)}
                />
              {:else if field.input === "number"}
                <Input
                  {id}
                  type="number"
                  name={field.arg}
                  required={field.required}
                  min={field.min}
                  max={field.max}
                  step={field.integer ? 1 : "any"}
                  value={text(field.arg)}
                />
              {:else if field.input === "select"}
                <Select {id} name={field.arg} required={field.required} value={text(field.arg)}>
                  {#if !field.required}<option value="">–</option>{/if}
                  {#each field.options as option (option.value)}
                    <option value={option.value}>{option.label}</option>
                  {/each}
                </Select>
              {/if}
              {#if field.description}<p class="text-xs text-muted-foreground">{field.description}</p>{/if}
            </div>
          {/if}
        {/each}
        <div>
          <Button type="submit">{section.submitLabel}</Button>
        </div>
      </form>
    {/if}
  </CardContent>
</Card>
