<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Epic #1644 (#1645) — a plugin's generated settings form. Fields come
   * from the plugin's declared schema, grouped by their first path segment;
   * the submit sends only the changed fields as one merge patch.
   */

  import { enhance } from "$app/forms";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#lib/components/ui/card/index.js";
  import ConfigField from "./ConfigField.svelte";
  import { configPatch, setAt, valueAt } from "./config-patch.js";

  interface Field {
    path: string;
    type: string;
    label: string;
    description: string;
    effect: string;
    gate: string;
    scope: string;
    spec: Record<string, unknown>;
  }

  interface Props {
    fields: Field[];
    values: Record<string, unknown>;
    pageTypes: { slug: string; name: string }[];
    lists: { id: string; name: string; type: string }[];
    csrfToken: string;
  }

  let { fields, values, pageTypes, lists, csrfToken }: Props = $props();

  let edited = $state<Record<string, unknown>>(structuredClone($state.snapshot(values)) as Record<string, unknown>);
  $effect(() => {
    edited = structuredClone($state.snapshot(values)) as Record<string, unknown>;
  });

  const patch = $derived(configPatch(fields, values, edited));
  const dirty = $derived(Object.keys(patch).length > 0);

  /** Fields grouped by their first path segment; top-level leaves under "General". */
  const groups = $derived.by(() => {
    const out = new Map<string, Field[]>();
    for (const f of fields) {
      const key = f.path.includes(".") ? (f.path.split(".")[0] as string) : "";
      out.set(key, [...(out.get(key) ?? []), f]);
    }
    return [...out.entries()];
  });

  function title(key: string): string {
    return key === "" ? "General" : key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  }
</script>

<form method="POST" action="?/save" class="space-y-6" use:enhance>
  <input type="hidden" name="_csrf" value={csrfToken} />
  <input type="hidden" name="patch" value={JSON.stringify(patch)} />
  {#each groups as [key, groupFields] (key)}
    <Card>
      <CardHeader>
        <CardTitle>{title(key)}</CardTitle>
        {#if key !== ""}<CardDescription>{groupFields.length} settings</CardDescription>{/if}
      </CardHeader>
      <CardContent class="space-y-5">
        {#each groupFields as f (f.path)}
          <ConfigField
            id={`cfg-${f.path}`}
            label={f.label}
            description={f.description}
            spec={f.spec as never}
            gate={f.gate}
            scope={f.scope}
            value={valueAt(edited, f.path)}
            {pageTypes}
            {lists}
            onchange={(v) => {
              const next = structuredClone($state.snapshot(edited)) as Record<string, unknown>;
              setAt(next, f.path, v);
              edited = next;
            }}
          />
        {/each}
      </CardContent>
    </Card>
  {/each}
  <div class="flex items-center gap-3">
    <Button type="submit" disabled={!dirty}>Save</Button>
    {#if dirty}<span class="text-sm text-muted-foreground">{Object.keys(patch).length} changed {Object.keys(patch).length === 1 ? "area" : "areas"}</span>{/if}
  </div>
</form>
