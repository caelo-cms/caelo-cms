<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P7 — modal media picker. Opens via parent state (`bind:open`) and
   * calls `onPick({ url, alt })` when the user selects an asset. The
   * URL is the canonical `/_caelo/media/<id>/<variant>` (WebP-800 for
   * raster images, `orig` otherwise) — drop straight into module HTML.
   */

  import { Search } from "lucide-svelte";
  import { onMount } from "svelte";
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog/index.js";
  import { Input } from "$lib/components/ui/input/index.js";

  type AssetSummary = {
    id: string;
    mime: string;
    originalName: string;
    width: number | null;
    height: number | null;
    alt: string;
    variants: { variant: string }[];
  };

  interface Props {
    open: boolean;
    onClose?: () => void;
    onPick: (m: { url: string; alt: string }) => void;
  }
  let { open = $bindable(), onClose, onPick }: Props = $props();

  const RASTER = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/avif",
    "image/gif",
  ]);

  let query = $state("");
  let assets = $state<AssetSummary[]>([]);
  let loading = $state(false);

  async function fetchAssets(): Promise<void> {
    loading = true;
    const params = new URLSearchParams();
    params.set("sort", "most_used");
    if (query) params.set("q", query);
    try {
      const res = await fetch(`/api/media/list?${params.toString()}`);
      if (res.ok) {
        const json = (await res.json()) as { assets: AssetSummary[] };
        assets = json.assets;
      }
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void fetchAssets();
  });

  $effect(() => {
    if (open) void fetchAssets();
  });

  function pickVariant(a: AssetSummary): string {
    return a.variants.find((v) => v.variant === "webp-800") ? "webp-800" : "orig";
  }

  function thumbVariant(a: AssetSummary): string {
    return a.variants.find((v) => v.variant === "webp-400") ? "webp-400" : "orig";
  }

  function pick(a: AssetSummary): void {
    onPick({
      url: `/_caelo/media/${a.id}/${pickVariant(a)}`,
      alt: a.alt,
    });
    open = false;
    onClose?.();
  }
</script>

<Dialog
  open={open}
  onOpenChange={(o) => {
    open = o;
    if (!o) onClose?.();
  }}
>
  <DialogContent class="max-w-3xl">
    <DialogHeader>
      <DialogTitle>Insert media</DialogTitle>
      <DialogDescription>
        Pick an image, PDF, or video from the library. Upload new assets at
        <a class="underline" href="/content/media/upload" target="_blank" rel="noopener">/content/media/upload</a
        >.
      </DialogDescription>
    </DialogHeader>

    <div class="space-y-3">
      <div class="relative">
        <Search class="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          placeholder="Search alt or filename"
          value={query}
          oninput={(e) => {
            query = (e.currentTarget as HTMLInputElement).value;
            void fetchAssets();
          }}
          class="pl-7"
        />
      </div>

      {#if loading}
        <p class="text-sm text-muted-foreground">Loading…</p>
      {:else if assets.length === 0}
        <p class="text-sm text-muted-foreground">No assets found.</p>
      {:else}
        <ul class="grid max-h-[60vh] grid-cols-3 gap-2 overflow-auto sm:grid-cols-4 md:grid-cols-5">
          {#each assets as a (a.id)}
            <li>
              <button
                type="button"
                class="block w-full overflow-hidden rounded-md border border-border text-left transition-shadow hover:shadow-md motion-reduce:transition-none"
                onclick={() => pick(a)}
                title={`${a.originalName} — ${a.alt || "(no alt)"}`}
              >
                <div class="aspect-square bg-muted/50">
                  {#if RASTER.has(a.mime) || a.mime === "image/svg+xml"}
                    <img
                      src={`/_caelo/media/${a.id}/${thumbVariant(a)}`}
                      alt={a.alt}
                      class="size-full object-cover"
                      loading="lazy"
                    />
                  {:else}
                    <div class="flex size-full items-center justify-center text-xs text-muted-foreground">
                      {a.mime.split("/")[1]?.toUpperCase() ?? a.mime}
                    </div>
                  {/if}
                </div>
                <p class="truncate px-2 py-1 text-xs">{a.originalName}</p>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </DialogContent>
</Dialog>
