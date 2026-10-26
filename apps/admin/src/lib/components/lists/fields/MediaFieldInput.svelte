<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * `media` field (epic #1107): pick an asset from the media library. The
   * value is the asset's media address; it is stored as a media reference
   * on save, so renaming the asset never breaks the entry.
   */
  import MediaPicker from "#lib/components/MediaPicker.svelte";
  import { Button } from "#lib/components/ui/button/index.js";

  interface Props {
    id: string;
    value: unknown;
    disabled: boolean;
    onchange: (v: unknown) => void;
  }
  let { id, value, disabled, onchange }: Props = $props();
  let open = $state(false);
  const src = $derived(typeof value === "string" && value.startsWith("/") ? value : null);
</script>

<div class="flex items-center gap-3" {id}>
  {#if src}
    <img {src} alt="" class="size-14 rounded border object-cover" />
  {:else if typeof value === "string" && value !== ""}
    <span class="text-xs text-muted-foreground">{value}</span>
  {:else}
    <span class="text-xs text-muted-foreground">No image</span>
  {/if}
  <Button type="button" variant="outline" size="sm" {disabled} onclick={() => (open = true)}
    >Choose…</Button
  >
  {#if value}
    <Button type="button" variant="ghost" size="sm" {disabled} onclick={() => onchange(undefined)}
      >Remove</Button
    >
  {/if}
</div>
<MediaPicker bind:open onPick={(m) => onchange(m.url)} />
