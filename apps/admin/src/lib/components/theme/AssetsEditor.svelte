<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  // v0.11.1 (issue #76) — Assets tab. Four slots (logo / logoDark /
  // favicon / socialShare) each backed by themes.set_asset. Replace
  // opens MediaPicker; Clear submits a null mediaId.
  import { Button } from "$lib/components/ui/button/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import MediaPicker from "$lib/components/MediaPicker.svelte";

  interface AssetRef {
    mediaId: string;
    url: string;
  }
  interface ThemeAssets {
    logo: AssetRef | null;
    logoDark: AssetRef | null;
    favicon: AssetRef | null;
    socialShare: AssetRef | null;
  }

  interface Props {
    assets: ThemeAssets;
    csrfToken: string;
    themeSlug: string;
  }
  let { assets, csrfToken, themeSlug }: Props = $props();

  type Slot = "logo" | "logoDark" | "favicon" | "socialShare";
  const SLOTS: Array<{ key: Slot; label: string; hint: string }> = [
    { key: "logo", label: "Logo", hint: "Site logo. `{{theme_logo_url}}` in modules resolves to this." },
    { key: "logoDark", label: "Logo (dark)", hint: "Dark-mode logo. `{{theme_logo_dark_url}}` substitutes." },
    { key: "favicon", label: "Favicon", hint: "`{{theme_favicon_url}}` for <link rel='icon'>." },
    {
      key: "socialShare",
      label: "Social share image",
      hint: "Default OG/Twitter card image. `{{theme_social_share_url}}` substitutes.",
    },
  ];

  let pickerOpen = $state(false);
  let activeSlot = $state<Slot | null>(null);
  let pendingMediaId = $state("");
  let formSubmitTrigger = $state<HTMLButtonElement | null>(null);

  function openPicker(slot: Slot): void {
    activeSlot = slot;
    pickerOpen = true;
  }

  function onMediaPick(m: { url: string; alt: string; mediaId: string }): void {
    if (!activeSlot) return;
    pendingMediaId = m.mediaId;
    // Defer to next tick so the bound input picks up the value.
    setTimeout(() => formSubmitTrigger?.click(), 0);
  }
</script>

<div class="space-y-4">
  <p class="text-sm text-muted-foreground">
    Bind brand assets to the four theme slots. Module HTML carrying
    <code>{`{{theme_logo_url}}`}</code> / <code>{`{{theme_logo_dark_url}}`}</code> /
    <code>{`{{theme_favicon_url}}`}</code> / <code>{`{{theme_social_share_url}}`}</code> resolves
    to the URLs below at render time.
  </p>

  <div class="space-y-3">
    {#each SLOTS as slot (slot.key)}
      {@const ref = assets[slot.key]}
      <div class="flex items-center gap-4 rounded-md border p-3">
        <div class="flex-1 min-w-0">
          <Label class="text-sm">{slot.label}</Label>
          <p class="text-xs text-muted-foreground">{slot.hint}</p>
        </div>
        {#if ref}
          <img
            src={ref.url}
            alt={`${slot.label} preview`}
            class="size-14 shrink-0 rounded border object-contain bg-muted"
          />
        {:else}
          <div
            class="flex size-14 shrink-0 items-center justify-center rounded border bg-muted text-xs text-muted-foreground"
          >
            unbound
          </div>
        {/if}
        <Button type="button" variant="outline" size="sm" onclick={() => openPicker(slot.key)}>
          {ref ? "Replace" : "Bind"}
        </Button>
        {#if ref}
          <form method="post" action="?/setAsset">
            <input type="hidden" name="_csrf" value={csrfToken} />
            <input type="hidden" name="themeSlug" value={themeSlug} />
            <input type="hidden" name="slot" value={slot.key} />
            <input type="hidden" name="mediaId" value="" />
            <Button type="submit" variant="ghost" size="sm">Clear</Button>
          </form>
        {/if}
      </div>
    {/each}
  </div>

  <!-- Hidden form posted by the MediaPicker callback -->
  <form method="post" action="?/setAsset" class="hidden">
    <input type="hidden" name="_csrf" value={csrfToken} />
    <input type="hidden" name="themeSlug" value={themeSlug} />
    <input type="hidden" name="slot" value={activeSlot ?? ""} />
    <input type="hidden" name="mediaId" value={pendingMediaId} />
    <button type="submit" bind:this={formSubmitTrigger} aria-hidden="true">submit</button>
  </form>
</div>

<MediaPicker bind:open={pickerOpen} onPick={onMediaPick} />
