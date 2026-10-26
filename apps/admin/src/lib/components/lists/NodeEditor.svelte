<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * One node kind of a list type (epic #1107, docs/lists.md §3): its
   * fields, what may hang under it (children) or what fills it (a source),
   * and which link marks the entry as the current page. A saved kind keeps
   * its key: renaming it would drop every entry of the old kind.
   */

  import {
    type ListTypeDef,
    type NodeDef,
    QUERY_KNOBS,
    type QueryKnob,
    SYSTEM_SOURCE_NAMES,
  } from "@caelo-cms/shared";
  import { Trash2 } from "lucide-svelte";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Select } from "#lib/components/ui/select/index.js";
  import type { FieldEditorContext } from "#lib/lists/field-context.js";
  import { KNOB_LABELS, ORDER_LABELS } from "#lib/lists/query-knobs.js";
  import { contentModeOf, linkFieldNames, withContentMode } from "#lib/lists/type-editor.js";
  import FieldsEditor from "./FieldsEditor.svelte";

  interface Props {
    def: ListTypeDef;
    kind: string;
    node: NodeDef;
    saved: boolean;
    savedFieldNames: ReadonlySet<string>;
    ctx: FieldEditorContext;
    onchange: (node: NodeDef) => void;
    onrename: (kind: string) => void;
    onremove: () => void;
  }
  let { def, kind, node, saved, savedFieldNames, ctx, onchange, onrename, onremove }: Props =
    $props();

  const ro = $derived(ctx.readOnly);
  const mode = $derived(contentModeOf(node));
  const kinds = $derived(Object.keys(def.nodes));
  const links = $derived(linkFieldNames(node));
  const id = $derived(`node-${kind}`);

  function toggleAllow(k: string, on: boolean): void {
    if (!node.children) return;
    const allow = on ? [...node.children.allow, k] : node.children.allow.filter((x) => x !== k);
    onchange({ ...node, children: { ...node.children, allow } });
  }
  function setQuery(p: Partial<Extract<NonNullable<NodeDef["source"]>, { kind: "query" }>>): void {
    if (node.source?.kind !== "query") return;
    onchange({ ...node, source: { ...node.source, ...p } });
  }
  function toggleKnob(k: QueryKnob, on: boolean): void {
    if (node.source?.kind !== "query") return;
    const editable = on ? [...node.source.editable, k] : node.source.editable.filter((x) => x !== k);
    setQuery({ editable });
  }
</script>

<section class="space-y-3 rounded-lg border p-4" data-testid="node-editor" data-kind={kind}>
  <div class="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
    <div class="space-y-1">
      <Label for={`${id}-label`}>Entry kind</Label>
      <Input id={`${id}-label`} value={node.label} disabled={ro} oninput={(e) => onchange({ ...node, label: (e.currentTarget as HTMLInputElement).value })} />
    </div>
    <div class="space-y-1">
      <Label for={`${id}-kind`}>Name in templates</Label>
      <Input
        id={`${id}-kind`}
        value={kind}
        disabled={ro || saved}
        title={saved ? "A saved kind keeps its name — renaming would drop its entries." : undefined}
        onchange={(e) => onrename((e.currentTarget as HTMLInputElement).value.trim())}
      />
    </div>
    {#if !ro}
      <div class="flex items-end">
        <button type="button" class="rounded p-2 text-destructive hover:bg-accent" aria-label={`Remove ${node.label}`} onclick={onremove}><Trash2 class="size-4" /></button>
      </div>
    {/if}
  </div>

  <div class="space-y-1">
    <p class="text-sm font-medium">Fields</p>
    <FieldsEditor fields={node.fields} savedNames={savedFieldNames} {ctx} idPrefix={`${id}-f`} onchange={(fields) => onchange({ ...node, fields })} />
  </div>

  <div class="grid gap-3 md:grid-cols-2">
    <div class="space-y-1">
      <Label for={`${id}-mode`}>Below an entry</Label>
      <Select id={`${id}-mode`} value={mode} disabled={ro} onchange={(e: Event) => onchange(withContentMode(node, (e.currentTarget as HTMLSelectElement).value as typeof mode, kind))}>
        <option value="none">Nothing</option>
        <option value="children">Entries the editor adds</option>
        <option value="query">Pages found by a query</option>
        <option value="system">Pages from the site's structure</option>
        <option value="plugin">Entries from a plugin</option>
      </Select>
    </div>
    {#if links.length > 0}
      <div class="space-y-1">
        <Label for={`${id}-current`}>Highlights the current page by</Label>
        <Select id={`${id}-current`} value={node.current_from ?? ""} disabled={ro} onchange={(e: Event) => {
          const v = (e.currentTarget as HTMLSelectElement).value;
          const { current_from: _c, ...rest } = node;
          onchange(v ? { ...rest, current_from: v } : rest);
        }}>
          <option value="">Never</option>
          {#each links as l (l)}<option value={l}>{node.fields.find((f) => f.name === l)?.label ?? l}</option>{/each}
        </Select>
      </div>
    {/if}
  </div>

  {#if node.children}
    <div class="grid gap-3 rounded-md bg-muted/40 p-3 md:grid-cols-3">
      <div class="space-y-1">
        <Label for={`${id}-cname`}>Loop name in templates</Label>
        <Input id={`${id}-cname`} value={node.children.name} disabled={ro} oninput={(e) => node.children && onchange({ ...node, children: { ...node.children, name: (e.currentTarget as HTMLInputElement).value } })} />
      </div>
      <fieldset class="space-y-1">
        <legend class="text-sm font-medium">May contain</legend>
        {#each kinds as k (k)}
          <label class="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={node.children.allow.includes(k)} disabled={ro} onchange={(e) => toggleAllow(k, (e.currentTarget as HTMLInputElement).checked)} />
            {def.nodes[k]?.label ?? k}
          </label>
        {/each}
      </fieldset>
      <div class="space-y-1">
        <Label for={`${id}-cmax`}>At most</Label>
        <Input id={`${id}-cmax`} type="number" min={1} placeholder="no limit" value={node.children.max ?? ""} disabled={ro} oninput={(e) => {
          if (!node.children) return;
          const n = Number((e.currentTarget as HTMLInputElement).value);
          const { max: _m, ...c } = node.children;
          onchange({ ...node, children: Number.isInteger(n) && n > 0 ? { ...c, max: n } : c });
        }} />
      </div>
    </div>
  {:else if node.source?.kind === "query"}
    {@const src = node.source}
    <div class="grid gap-3 rounded-md bg-muted/40 p-3 md:grid-cols-3">
      <fieldset class="space-y-1">
        <legend class="text-sm font-medium">Editors may change</legend>
        {#each QUERY_KNOBS as k (k)}
          <label class="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={src.editable.includes(k)} disabled={ro} onchange={(e) => toggleKnob(k, (e.currentTarget as HTMLInputElement).checked)} />
            {KNOB_LABELS[k]}
          </label>
        {/each}
      </fieldset>
      <div class="space-y-1">
        <Label for={`${id}-qorder`}>Default order</Label>
        <Select id={`${id}-qorder`} value={String(src.defaults.order ?? "")} disabled={ro} onchange={(e: Event) => setQuery({ defaults: { ...src.defaults, order: (e.currentTarget as HTMLSelectElement).value as "title_asc" } })}>
          {#each Object.entries(ORDER_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
        </Select>
      </div>
      <div class="space-y-1">
        <Label for={`${id}-qlimit`}>Default number of pages</Label>
        <Input id={`${id}-qlimit`} type="number" min={1} max={50} value={src.defaults.limit ?? ""} disabled={ro} oninput={(e) => {
          const n = Number((e.currentTarget as HTMLInputElement).value);
          if (Number.isInteger(n) && n >= 1 && n <= 50) setQuery({ defaults: { ...src.defaults, limit: n } });
        }} />
      </div>
    </div>
  {:else if node.source?.kind === "system"}
    {@const src = node.source}
    <div class="rounded-md bg-muted/40 p-3">
      <Label for={`${id}-sys`}>Pages</Label>
      <Select id={`${id}-sys`} value={src.name} disabled={ro} onchange={(e: Event) => onchange({ ...node, source: { kind: "system", name: (e.currentTarget as HTMLSelectElement).value as typeof src.name } })}>
        {#each SYSTEM_SOURCE_NAMES as s (s)}<option value={s}>{s.replaceAll("_", " ")}</option>{/each}
      </Select>
    </div>
  {:else if node.source?.kind === "plugin"}
    {@const src = node.source}
    <div class="rounded-md bg-muted/40 p-3">
      <Label for={`${id}-plugin`}>Plugin source name</Label>
      <Input id={`${id}-plugin`} value={src.name} disabled={ro} oninput={(e) => onchange({ ...node, source: { kind: "plugin", name: (e.currentTarget as HTMLInputElement).value } })} />
    </div>
  {/if}
</section>
