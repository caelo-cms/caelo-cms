<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P7 — Media library list view. Grid of asset thumbnails (WebP-400
   * variant where present, original otherwise). Supports a free-text
   * filter on alt + filename via the `q` param and a sort toggle.
   */

  import { Image as ImageIcon, Search, Upload } from "lucide-svelte";
  import EmptyStatePlaceholder from "$lib/components/EmptyStatePlaceholder.svelte";
  import { Button, buttonVariants } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import { Input } from "$lib/components/ui/input/index.js";

  let { data } = $props();

  const RASTER = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/avif",
    "image/gif",
  ]);

  function thumbUrl(a: (typeof data.assets)[number]): string {
    const variant = a.variants.find((v) => v.variant === "webp-400")
      ? "webp-400"
      : "orig";
    return `/_caelo/media/${a.id}/${variant}`;
  }

  function fmtSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
</script>

<div class="space-y-6">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Media</h1>
      <p class="text-sm text-muted-foreground">
        Images, PDFs, and video referenced from module HTML. {data.totalCount} asset{data.totalCount === 1 ? "" : "s"}.
      </p>
    </div>
    <a href="/content/media/upload" class={buttonVariants({ variant: "default" })}>
      <Upload class="mr-2 size-4" />
      Upload
    </a>
  </div>

  <Card>
    <CardHeader class="flex-row items-center justify-between gap-4 space-y-0">
      <CardTitle class="text-base">Library</CardTitle>
      <form method="get" class="flex items-center gap-2">
        <input type="hidden" name="sort" value={data.sort} />
        <div class="relative">
          <Search class="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            name="q"
            placeholder="Search alt or filename"
            value={data.query}
            class="pl-7"
          />
        </div>
        <Button type="submit" variant="outline" size="sm">Search</Button>
        <a
          href={`?sort=recent${data.query ? `&q=${encodeURIComponent(data.query)}` : ""}`}
          class={buttonVariants({ variant: data.sort === "recent" ? "default" : "outline", size: "sm" })}
        >
          Recent
        </a>
        <a
          href={`?sort=most_used${data.query ? `&q=${encodeURIComponent(data.query)}` : ""}`}
          class={buttonVariants({ variant: data.sort === "most_used" ? "default" : "outline", size: "sm" })}
        >
          Most used
        </a>
      </form>
    </CardHeader>
    <CardContent>
      {#if data.assets.length === 0}
        <EmptyStatePlaceholder
          icon={ImageIcon}
          title={data.query ? "No matches" : "No media yet"}
          description={data.query
            ? "Try a different search term, or clear the filter."
            : "Upload an image, PDF, or video to reference it from your modules."}
        />
      {:else}
        <ul class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {#each data.assets as a (a.id)}
            <li class="group">
              <a
                href={`/content/media/${a.id}`}
                class="block overflow-hidden rounded-md border border-border transition-shadow hover:shadow-md motion-reduce:transition-none"
              >
                <div class="aspect-square bg-muted/50">
                  {#if RASTER.has(a.mime)}
                    <img
                      src={thumbUrl(a)}
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
                <div class="space-y-0.5 px-2 py-1.5 text-xs">
                  <p class="truncate font-medium" title={a.originalName}>{a.originalName}</p>
                  <p class="text-muted-foreground">
                    {fmtSize(a.sizeBytes)}
                    {#if a.width && a.height}
                      · {a.width}×{a.height}
                    {/if}
                    {#if a.usageCount > 0}
                      · used {a.usageCount}×
                    {/if}
                  </p>
                </div>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </CardContent>
  </Card>
</div>
