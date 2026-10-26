<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * `link` field (epic #1107): a target with the site's pages as
   * suggestions, and whether it opens in a new tab. A page path is stored
   * as a page reference on save, so the link follows the page when it
   * moves (epic #724).
   */
  import { Input } from "#lib/components/ui/input/index.js";
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

  const link = $derived(
    value && typeof value === "object"
      ? (value as { href?: string; target?: string })
      : { href: "" },
  );
  const pageTitle = $derived(ctx.pages.find((p) => p.path === link.href)?.title ?? null);

  function set(next: { href?: string; target?: string }): void {
    onchange({ ...link, ...next });
  }
</script>

<div class="space-y-1">
  <Input
    {id}
    type="text"
    list={`${id}-pages`}
    placeholder="/about or https://…"
    value={link.href ?? ""}
    required={spec.required}
    {disabled}
    oninput={(e) => set({ href: (e.currentTarget as HTMLInputElement).value })}
  />
  <datalist id={`${id}-pages`}>
    {#each ctx.pages as p (p.id)}
      <option value={p.path}>{p.title}</option>
    {/each}
  </datalist>
  <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
    <span>{pageTitle ? `Page: ${pageTitle}` : "Type a page address or pick one from the suggestions."}</span>
    <label class="inline-flex items-center gap-1">
      <input
        type="checkbox"
        checked={link.target === "_blank"}
        {disabled}
        onchange={(e) =>
          set({ target: (e.currentTarget as HTMLInputElement).checked ? "_blank" : undefined })}
      />
      Open in a new tab
    </label>
  </div>
</div>
