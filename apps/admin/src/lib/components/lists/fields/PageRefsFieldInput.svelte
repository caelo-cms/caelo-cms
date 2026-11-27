<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * `page` property (#1754): the pages this page names, in order — an
   * article's authors, its reviewer. The chosen pages show by title and
   * can be reordered or removed; a picker offers the site's pages (only
   * the property's page type, when it names one). The value is the array
   * of `caelo:page/<id>` references; a read shows paths, which the save
   * stores as references again, so the names follow the pages through
   * moves and renames.
   */
  import { ArrowDown, ArrowUp, X } from "lucide-svelte";
  import { Select } from "#lib/components/ui/select/index.js";
  import type { FieldEditorContext } from "#lib/lists/field-context.js";
  import type { FieldInputSpec } from "#lib/lists/field-form.js";

  interface Props {
    id: string;
    spec: FieldInputSpec;
    value: unknown;
    disabled: boolean;
    ctx: FieldEditorContext;
    onchange: (v: unknown) => void;
  }
  let { id, spec, value, disabled, ctx, onchange }: Props = $props();

  type Pick = FieldEditorContext["pages"][number];
  const REF = /^caelo:page\/([0-9a-f-]{36})$/;
  const trim = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);

  /** The page an item names: a reference, or a path as reads show it. */
  function pageOf(item: string): Pick | undefined {
    const ref = REF.exec(item)?.[1];
    if (ref !== undefined) return ctx.pages.find((p) => p.id === ref);
    return ctx.pages.find((p) => trim(p.path) === trim(item));
  }

  const items = $derived(
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [],
  );
  const chosen = $derived(items.map((item) => ({ item, page: pageOf(item) })));
  const choices = $derived(
    ctx.pages.filter(
      (p) =>
        (spec.pageType === undefined || p.pageType === undefined || p.pageType === spec.pageType) &&
        !chosen.some((c) => c.page?.id === p.id),
    ),
  );
  const full = $derived(!spec.multiple && items.length >= 1);

  /** Every known page as its reference; an unknown item stays as written (the save names it). */
  function emit(next: readonly { item: string; page: Pick | undefined }[]): void {
    onchange(next.map((c) => (c.page ? `caelo:page/${c.page.id}` : c.item)));
  }
  function move(i: number, delta: -1 | 1): void {
    const j = i + delta;
    if (j < 0 || j >= chosen.length) return;
    const next = [...chosen];
    [next[i], next[j]] = [next[j] as (typeof chosen)[number], next[i] as (typeof chosen)[number]];
    emit(next);
  }
</script>

<div class="space-y-1" data-testid={`page-refs-${spec.name}`}>
  {#if chosen.length > 0}
    <ol class="space-y-1">
      {#each chosen as c, i (c.item)}
        <li class="flex items-center gap-2 rounded border px-2 py-1 text-sm" data-testid="page-ref">
          <span class="flex-1">
            {#if c.page}{c.page.title} <span class="text-xs text-muted-foreground">{c.page.path}</span>
            {:else}<span class="text-destructive">{c.item} (no such page)</span>{/if}
          </span>
          {#if !disabled}
            {#if spec.multiple}
              <button type="button" class="rounded p-1 hover:bg-accent" aria-label="Move up" onclick={() => move(i, -1)}><ArrowUp class="size-3.5" /></button>
              <button type="button" class="rounded p-1 hover:bg-accent" aria-label="Move down" onclick={() => move(i, 1)}><ArrowDown class="size-3.5" /></button>
            {/if}
            <button type="button" class="rounded p-1 text-destructive hover:bg-accent" aria-label="Remove" onclick={() => emit(chosen.filter((_, k) => k !== i))}><X class="size-3.5" /></button>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
  {#if !disabled && !full}
    <Select
      {id}
      value=""
      required={spec.required && chosen.length === 0}
      onchange={(e: Event) => {
        const el = e.currentTarget as HTMLSelectElement;
        const page = ctx.pages.find((p) => p.id === el.value);
        el.value = "";
        if (page) emit([...chosen, { item: `caelo:page/${page.id}`, page }]);
      }}
    >
      <option value="">{chosen.length === 0 ? "Choose a page…" : "Add a page…"}</option>
      {#each choices as p (p.id)}<option value={p.id}>{p.title} — {p.path}</option>{/each}
    </Select>
  {/if}
</div>
