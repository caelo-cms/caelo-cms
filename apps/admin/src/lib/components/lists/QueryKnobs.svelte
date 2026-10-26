<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * The knobs of a query-filled entry (epic #1107, docs/lists.md §6): only
   * the ones the type marks `editable`, the rest is the type's fixed
   * default. Below them a live preview of the pages the query returns
   * (`lists.preview_source`), fetched on demand so typing stays cheap.
   */

  import type { QueryKnob, SourceDef } from "@caelo-cms/shared";
  import { applyAction, deserialize } from "$app/forms";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Select } from "#lib/components/ui/select/index.js";
  import { type FieldEditorContext, termChoices } from "#lib/lists/field-context.js";
  import { effectiveQuery, KNOB_LABELS, ORDER_LABELS, setKnob } from "#lib/lists/query-knobs.js";

  interface Props {
    source: Extract<SourceDef, { kind: "query" }>;
    node: string;
    query: Record<string, unknown> | undefined;
    ctx: FieldEditorContext;
    pageTypes: readonly { slug: string; name: string; properties: readonly { name: string; label: string }[] }[];
    previewAvailable: boolean;
    csrfToken: string;
    idPrefix: string;
    onchange: (query: Record<string, unknown>) => void;
  }
  let {
    source,
    node,
    query,
    ctx,
    pageTypes,
    previewAvailable,
    csrfToken,
    idPrefix,
    onchange,
  }: Props = $props();

  const q = $derived(effectiveQuery(source, query) as Record<string, unknown>);
  const disabled = $derived(ctx.readOnly);
  const terms = $derived(ctx.vocabularies.flatMap((v) => termChoices(v).map((c) => ({ ...c, vocabulary: v.name }))));
  const propertyOrders = $derived(
    [...new Map(pageTypes.flatMap((t) => t.properties.map((p) => [p.name, p.label] as const))).entries()],
  );

  function set(knob: QueryKnob, value: unknown): void {
    onchange(setKnob(source, query, knob, value));
  }

  let previewState = $state<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "unavailable"; message: string }
    | { kind: "result"; entries: { title: string; path: string }[] }
  >({ kind: "idle" });

  /** Entries out of whatever shape the preview op answers with (title + link per page). */
  function entriesOf(value: unknown): { title: string; path: string }[] {
    const v = value as Record<string, unknown> | null;
    const list = (v && (v.items ?? v.entries ?? v.pages)) as unknown;
    if (!Array.isArray(list)) return [];
    return list.map((e) => {
      const r = (e ?? {}) as Record<string, unknown>;
      const vals = (r.values ?? r) as Record<string, unknown>;
      const link = vals.link as unknown;
      return {
        title: String(vals.title ?? vals.name ?? ""),
        path: typeof link === "string" ? link : String((link as { href?: string } | undefined)?.href ?? vals.path ?? ""),
      };
    });
  }

  async function preview(): Promise<void> {
    previewState = { kind: "loading" };
    const body = new FormData();
    body.set("_csrf", csrfToken);
    body.set("node", node);
    body.set("query", JSON.stringify(query ?? {}));
    const res = await fetch("?/previewSource", { method: "POST", body, headers: { "x-sveltekit-action": "true" } });
    const result = deserialize(await res.text());
    if (result.type === "success") {
      const data = result.data as { preview?: unknown; previewUnavailable?: string };
      previewState = data.previewUnavailable
        ? { kind: "unavailable", message: data.previewUnavailable }
        : { kind: "result", entries: entriesOf(data.preview) };
    } else {
      previewState = { kind: "idle" };
      await applyAction(result);
    }
  }
</script>

<div class="space-y-3 rounded-md border p-3" data-testid="query-knobs">
  <p class="text-sm font-medium">Pages shown here</p>
  {#if source.editable.length === 0}
    <p class="text-sm text-muted-foreground">This entry's pages are fixed by its type.</p>
  {/if}
  <div class="grid gap-3 md:grid-cols-2">
    {#each source.editable as knob (knob)}
      {@const id = `${idPrefix}-q-${knob}`}
      <div class="space-y-1">
        <Label for={id}>{KNOB_LABELS[knob]}</Label>
        {#if knob === "page_type"}
          <Select {id} value={String(q.page_type ?? "")} {disabled} onchange={(e: Event) => set(knob, (e.currentTarget as HTMLSelectElement).value || undefined)}>
            <option value="">Any page</option>
            {#each pageTypes as t (t.slug)}<option value={t.slug}>{t.name}</option>{/each}
          </Select>
        {:else if knob === "terms"}
          {@const selected = Array.isArray(q.terms) ? (q.terms as string[]) : []}
          <fieldset {id} class="flex max-h-40 flex-wrap gap-x-3 gap-y-1 overflow-auto">
            {#each terms as t (t.ref)}
              <label class="inline-flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(t.ref)}
                  {disabled}
                  onchange={(e) => {
                    const on = (e.currentTarget as HTMLInputElement).checked;
                    set(knob, on ? [...selected, t.ref] : selected.filter((r) => r !== t.ref));
                  }}
                />
                {t.name} <span class="text-xs text-muted-foreground">({t.vocabulary})</span>
              </label>
            {:else}
              <span class="text-sm text-muted-foreground">No categories or tags yet.</span>
            {/each}
          </fieldset>
        {:else if knob === "terms_mode"}
          <Select {id} value={String(q.terms_mode ?? "any")} {disabled} onchange={(e: Event) => set(knob, (e.currentTarget as HTMLSelectElement).value)}>
            <option value="any">Any of the terms</option>
            <option value="all">All of the terms</option>
          </Select>
        {:else if knob === "parent"}
          <Input
            {id}
            list={`${id}-pages`}
            placeholder="Any page"
            value={String(q.parent ?? "")}
            {disabled}
            onchange={(e) => set(knob, (e.currentTarget as HTMLInputElement).value.trim() || undefined)}
          />
          <datalist id={`${id}-pages`}>
            {#each ctx.pages as p (p.id)}<option value={p.path}>{p.title}</option>{/each}
          </datalist>
        {:else if knob === "exclude_current"}
          <input {id} type="checkbox" class="size-4" checked={q.exclude_current !== false} {disabled} onchange={(e) => set(knob, (e.currentTarget as HTMLInputElement).checked)} />
        {:else if knob === "order"}
          <Select {id} value={String(q.order ?? "")} {disabled} onchange={(e: Event) => set(knob, (e.currentTarget as HTMLSelectElement).value)}>
            {#each Object.entries(ORDER_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
            {#each propertyOrders as [name, label] (name)}
              <option value={`prop_desc:${name}`}>{label} (high to low)</option>
              <option value={`prop_asc:${name}`}>{label} (low to high)</option>
            {/each}
          </Select>
        {:else if knob === "limit"}
          <Input {id} type="number" min={1} max={50} value={String(q.limit ?? "")} {disabled} onchange={(e) => {
            const n = Number((e.currentTarget as HTMLInputElement).value);
            set(knob, Number.isInteger(n) && n >= 1 && n <= 50 ? n : undefined);
          }} />
        {/if}
      </div>
    {/each}
  </div>

  <div class="space-y-2 border-t pt-2" data-testid="query-preview">
    {#if !previewAvailable}
      <p class="text-sm text-muted-foreground">Preview unavailable: this version cannot show which pages the query returns yet.</p>
    {:else}
      <Button type="button" variant="outline" size="sm" onclick={preview} disabled={previewState.kind === "loading"}>
        {previewState.kind === "loading" ? "Loading…" : "Show the pages it returns"}
      </Button>
      {#if previewState.kind === "unavailable"}
        <p class="text-sm text-muted-foreground">Preview unavailable: {previewState.message}</p>
      {:else if previewState.kind === "result"}
        {#if previewState.entries.length === 0}
          <p class="text-sm text-muted-foreground">No page matches right now.</p>
        {:else}
          <ol class="list-decimal pl-5 text-sm">
            {#each previewState.entries as e, i (i)}<li>{e.title} <span class="text-muted-foreground">{e.path}</span></li>{/each}
          </ol>
        {/if}
      {/if}
    {/if}
  </div>
</div>
