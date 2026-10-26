<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * `module` field (epic #1107): an entry embeds a module (a teaser in a
   * mega menu). Picking a module creates its content right away — the
   * entry is the content holder, which is what makes this work in site
   * chrome — and the content is edited in the content library.
   */
  import { Button, buttonVariants } from "#lib/components/ui/button/index.js";
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

  const ref = $derived(
    value && typeof value === "object"
      ? (value as { moduleId?: string; contentInstanceId?: string })
      : null,
  );
  const candidates = $derived(
    ctx.modules.filter((m) => !spec.accepts?.length || spec.accepts.includes(m.type)),
  );
  const current = $derived(ctx.modules.find((m) => m.id === ref?.moduleId) ?? null);
  let busy = $state(false);

  async function pick(moduleId: string): Promise<void> {
    if (!moduleId || !ctx.createInstance) return;
    busy = true;
    try {
      const contentInstanceId = await ctx.createInstance(moduleId);
      if (contentInstanceId) onchange({ moduleId, contentInstanceId });
    } finally {
      busy = false;
    }
  }
</script>

<div class="space-y-2">
  {#if ref?.contentInstanceId}
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <span class="font-medium">{current?.displayName ?? "Module"}</span>
      <a
        class={buttonVariants({ variant: "outline", size: "sm" })}
        href={`/content/library/${ref.contentInstanceId}`}
        target="_blank"
        rel="noopener">Edit its content ↗</a
      >
      <Button type="button" variant="ghost" size="sm" {disabled} onclick={() => onchange(undefined)}
        >Remove</Button
      >
    </div>
  {:else if ctx.createInstance}
    <Select
      {id}
      value=""
      disabled={disabled || busy}
      onchange={(e: Event) => void pick((e.currentTarget as HTMLSelectElement).value)}
    >
      <option value="">Pick a module to embed…</option>
      {#each candidates as m (m.id)}
        <option value={m.id}>{m.displayName}{m.description ? ` — ${m.description.slice(0, 60)}` : ""}</option>
      {/each}
    </Select>
  {:else}
    <p class="text-sm text-muted-foreground">No module embedded.</p>
  {/if}
</div>
