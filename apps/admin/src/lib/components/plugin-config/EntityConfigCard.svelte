<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Epic #1644 (#1645) — a plugin's settings per page, module, content
   * block or page type: the entities that have some, and a form that sets
   * them for one entity. A field left empty keeps (or returns to) its default.
   */

  import { enhance } from "$app/forms";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#lib/components/ui/card/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Select } from "#lib/components/ui/select/index.js";
  import ConfigField from "./ConfigField.svelte";
  import PageRefPicker from "./PageRefPicker.svelte";

  interface Field {
    path: string;
    label: string;
    description: string;
    gate: string;
    scope: string;
    spec: Record<string, unknown>;
  }

  let {
    kind,
    title,
    fields,
    configured,
    modules,
    pageTypes,
    lists,
    csrfToken,
  }: {
    kind: string;
    title: string;
    fields: Field[];
    configured: { id: string; label: string; values: Record<string, unknown> }[];
    modules: { id: string; name: string }[];
    pageTypes: { slug: string; name: string }[];
    lists: { id: string; name: string; type: string }[];
    csrfToken: string;
  } = $props();

  let entityId = $state<string | null>(null);
  let edited = $state<Record<string, unknown>>({});

  const current = $derived(configured.find((c) => c.id === entityId)?.values ?? {});

  function choose(id: string | null): void {
    entityId = id;
    edited = {};
  }

  /** Every field: an edited value, or null (the default) when it was cleared. */
  const values = $derived(
    Object.fromEntries(fields.map((f) => [f.path, f.path in edited ? edited[f.path] : (current[f.path] ?? null)])),
  );
  const reset = $derived(Object.fromEntries(fields.map((f) => [f.path, null])));

  function summary(v: Record<string, unknown>): string {
    return fields
      .map((f) => `${f.label}: ${v[f.path] === null || v[f.path] === undefined ? "default" : String(v[f.path])}`)
      .join(" · ");
  }
</script>

<Card>
  <CardHeader>
    <CardTitle>{title}</CardTitle>
    <CardDescription>Unset fields use their default. Saved values reach the site with the next Stage and Publish live.</CardDescription>
  </CardHeader>
  <CardContent class="space-y-4">
    {#if configured.length > 0}
      <ul class="divide-y rounded-md border text-sm">
        {#each configured as c (c.id)}
          <li class="flex items-center justify-between gap-2 px-3 py-2">
            <button type="button" class="text-left" onclick={() => choose(c.id)}>
              <span class="font-medium">{c.label}</span>
              <span class="block text-xs text-muted-foreground">{summary(c.values)}</span>
            </button>
            <form method="POST" action="?/saveEntity" use:enhance>
              <input type="hidden" name="_csrf" value={csrfToken} />
              <input type="hidden" name="kind" value={kind} />
              <input type="hidden" name="id" value={c.id} />
              <input type="hidden" name="values" value={JSON.stringify(reset)} />
              <Button type="submit" variant="outline" size="sm">Reset</Button>
            </form>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="text-sm text-muted-foreground">Nothing set yet: every {kind === "page" ? "page" : kind === "module" ? "module" : "entry"} uses the defaults.</p>
    {/if}

    <div class="space-y-2">
      <Label for={`entity-${kind}`}>Set for</Label>
      {#if kind === "page"}
        <PageRefPicker id={`entity-${kind}`} value={entityId} onchange={choose} />
      {:else if kind === "module"}
        <Select id={`entity-${kind}`} value={entityId ?? ""} onchange={(e) => choose((e.currentTarget as HTMLSelectElement).value || null)}>
          <option value="">Choose a module…</option>
          {#each modules as m (m.id)}<option value={m.id}>{m.name}</option>{/each}
        </Select>
      {:else if kind === "pageType"}
        <Select id={`entity-${kind}`} value={entityId ?? ""} onchange={(e) => choose((e.currentTarget as HTMLSelectElement).value || null)}>
          <option value="">Choose a page type…</option>
          {#each pageTypes as t (t.slug)}<option value={t.slug}>{t.name}</option>{/each}
        </Select>
      {:else}
        <Input id={`entity-${kind}`} class="max-w-80 font-mono" placeholder="Content block id" value={entityId ?? ""} oninput={(e) => choose((e.currentTarget as HTMLInputElement).value.trim() || null)} />
      {/if}
    </div>

    {#if entityId}
      <form method="POST" action="?/saveEntity" use:enhance class="space-y-4">
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="id" value={entityId} />
        <input type="hidden" name="values" value={JSON.stringify(values)} />
        {#each fields as f (f.path)}
          <ConfigField
            id={`entity-${kind}-${f.path}`}
            label={f.label}
            description={f.description}
            spec={f.spec as never}
            gate={f.gate}
            scope={f.scope}
            value={values[f.path]}
            {pageTypes}
            {lists}
            onchange={(v) => (edited = { ...edited, [f.path]: v })}
          />
        {/each}
        <Button type="submit">Save</Button>
      </form>
    {/if}
  </CardContent>
</Card>
