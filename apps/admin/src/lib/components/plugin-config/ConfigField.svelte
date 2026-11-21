<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Epic #1644 (#1645) — one field of a plugin's generated settings form,
   * rendered from its declaration. A map is a small table of key and value.
   */

  import { Plus, Trash2 } from "lucide-svelte";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Select } from "#lib/components/ui/select/index.js";
  import { Textarea } from "#lib/components/ui/textarea/index.js";

  interface Spec {
    type: string;
    min?: number;
    max?: number;
    maxLength?: number;
    multiline?: boolean;
    options?: { value: string; label: string }[];
    keys?: string;
    listType?: string;
    value?: Spec;
  }

  interface Props {
    id: string;
    label: string;
    description: string;
    spec: Spec;
    gate: string;
    scope: string;
    value: unknown;
    pageTypes: { slug: string; name: string }[];
    lists: { id: string; name: string; type: string }[];
    onchange: (value: unknown) => void;
  }

  let { id, label, description, spec, gate, scope, value, pageTypes, lists, onchange }: Props = $props();

  let newKey = $state("");

  function scalarFromInput(s: Spec, raw: string): unknown {
    if (s.type === "int") return raw === "" ? null : Number.parseInt(raw, 10);
    if (s.type === "number") return raw === "" ? null : Number(raw);
    return raw;
  }

  const mapValue = $derived((value ?? {}) as Record<string, unknown>);

  function setMapKey(key: string, v: unknown): void {
    onchange({ ...mapValue, [key]: v });
  }

  function removeMapKey(key: string): void {
    const next = { ...mapValue };
    delete next[key];
    onchange(next);
  }

  function addMapKey(): void {
    const key = newKey.trim();
    if (!key || key in mapValue || !spec.value) return;
    setMapKey(key, (spec.value as Spec & { default?: unknown }).default ?? null);
    newKey = "";
  }
</script>

<div class="space-y-1.5">
  <div class="flex flex-wrap items-center gap-2">
    <Label for={id}>{label}</Label>
    {#if gate === "approval"}<Badge variant="outline">needs approval in chats</Badge>{/if}
    {#if scope === "immediate"}<Badge variant="secondary">applies at once</Badge>{/if}
  </div>
  <p class="text-xs text-muted-foreground">{description}</p>

  {#snippet scalar(s: Spec, v: unknown, inputId: string, set: (x: unknown) => void)}
    {#if s.type === "bool"}
      <input id={inputId} type="checkbox" class="size-4" checked={v === true} onchange={(e) => set((e.currentTarget as HTMLInputElement).checked)} />
    {:else if s.type === "int" || s.type === "number"}
      <Input id={inputId} type="number" class="max-w-40" min={s.min} max={s.max} step={s.type === "int" ? 1 : "any"} value={v === null || v === undefined ? "" : String(v)} oninput={(e) => set(scalarFromInput(s, (e.currentTarget as HTMLInputElement).value))} />
    {:else if s.type === "enum"}
      <Select id={inputId} class="max-w-64" value={String(v ?? "")} onchange={(e) => set((e.currentTarget as HTMLSelectElement).value)}>
        {#each s.options ?? [] as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
      </Select>
    {:else if s.type === "string" && (s.multiline || (s.maxLength ?? 0) > 200)}
      <Textarea id={inputId} rows={4} maxlength={s.maxLength} value={String(v ?? "")} oninput={(e) => set((e.currentTarget as HTMLTextAreaElement).value)} />
    {:else}
      <Input id={inputId} maxlength={s.maxLength} value={String(v ?? "")} oninput={(e) => set((e.currentTarget as HTMLInputElement).value)} />
    {/if}
  {/snippet}

  {#if spec.type === "map" && spec.value}
    <div class="space-y-2 rounded-md border p-2">
      {#each Object.entries(mapValue) as [key, v] (key)}
        <div class="flex items-center gap-2">
          <span class="w-40 truncate font-mono text-xs">{spec.keys === "pageType" ? (pageTypes.find((t) => t.slug === key)?.name ?? key) : key}</span>
          {@render scalar(spec.value, v, `${id}-${key}`, (x) => setMapKey(key, x))}
          <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${key}`} onclick={() => removeMapKey(key)}><Trash2 class="size-4" /></Button>
        </div>
      {:else}
        <p class="text-xs text-muted-foreground">No entries: every key uses the default.</p>
      {/each}
      <div class="flex items-center gap-2">
        {#if spec.keys === "pageType"}
          <Select class="max-w-56" bind:value={newKey} aria-label="Page type">
            <option value="">Add a page type…</option>
            {#each pageTypes.filter((t) => !(t.slug in mapValue)) as t (t.slug)}<option value={t.slug}>{t.name}</option>{/each}
          </Select>
        {:else}
          <Input class="max-w-56" placeholder={spec.keys === "language" ? "Language, e.g. de" : "Key"} bind:value={newKey} />
        {/if}
        <Button type="button" variant="outline" size="sm" onclick={addMapKey}><Plus class="size-4" /> Add</Button>
      </div>
    </div>
  {:else if spec.type === "listRef"}
    <Select id={id} class="max-w-80" value={String(value ?? "")} onchange={(e) => onchange((e.currentTarget as HTMLSelectElement).value || null)}>
      <option value="">No list</option>
      {#each lists.filter((l) => l.type === spec.listType) as l (l.id)}<option value={l.id}>{l.name}</option>{/each}
    </Select>
  {:else if spec.type === "pageRef" || spec.type === "catalogModel"}
    <Input id={id} class="max-w-80 font-mono" placeholder={spec.type === "pageRef" ? "Page id" : "Model id"} value={String(value ?? "")} oninput={(e) => onchange((e.currentTarget as HTMLInputElement).value || null)} />
  {:else}
    {@render scalar(spec, value, id, onchange)}
  {/if}
</div>
