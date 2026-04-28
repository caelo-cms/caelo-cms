<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P7 — media asset detail. Preview + variant grid + alt editor +
   * "used in" panel + delete (Owner-only).
   */

  import { Trash2 } from "lucide-svelte";
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";

  let { data, form } = $props();

  type Variant = {
    variant: string;
    format: string;
    width: number | null;
    height: number | null;
    sizeBytes: number;
  };
  type Asset = {
    id: string;
    sha256: string;
    originalName: string;
    mime: string;
    sizeBytes: number;
    width: number | null;
    height: number | null;
    alt: string;
    usageCount: number;
    createdAt: string;
    variants: Variant[];
  };
  const asset = data.asset as Asset;

  const RASTER = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/avif",
    "image/gif",
  ]);

  let confirmDelete = $state(false);

  function fmtSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  function previewUrl(variant: string): string {
    return `/_caelo/media/${asset.id}/${variant}`;
  }

  const previewVariant = (() => {
    if (asset.variants.find((v) => v.variant === "webp-800")) return "webp-800";
    return "orig";
  })();
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">{asset.originalName}</h1>
    <p class="font-mono text-xs text-muted-foreground">
      {asset.mime} · {fmtSize(asset.sizeBytes)}
      {#if asset.width && asset.height}
        · {asset.width}×{asset.height}
      {/if}
      · used {asset.usageCount}×
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok && form?.message}
    <Alert><AlertDescription>{form.message}</AlertDescription></Alert>
  {/if}

  <div class="grid gap-6 lg:grid-cols-3">
    <Card class="lg:col-span-2">
      <CardHeader><CardTitle class="text-base">Preview</CardTitle></CardHeader>
      <CardContent>
        <div class="flex items-center justify-center rounded-md bg-muted/30 p-4">
          {#if RASTER.has(asset.mime)}
            <img
              src={previewUrl(previewVariant)}
              alt={asset.alt}
              class="max-h-[60vh] w-auto"
              loading="eager"
            />
          {:else if asset.mime === "image/svg+xml"}
            <img
              src={previewUrl("orig")}
              alt={asset.alt}
              class="max-h-[60vh] w-auto"
              loading="eager"
            />
          {:else if asset.mime === "video/mp4"}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video src={previewUrl("orig")} controls class="max-h-[60vh] w-auto"></video>
          {:else}
            <p class="text-sm text-muted-foreground">No inline preview for {asset.mime}.</p>
          {/if}
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader><CardTitle class="text-base">Alt text</CardTitle></CardHeader>
      <CardContent>
        <form method="post" action="?/updateAlt" class="space-y-3">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <Label for="alt" class="sr-only">Alt</Label>
          <Textarea id="alt" name="alt" rows={4} value={asset.alt} />
          <Button type="submit">Save alt</Button>
        </form>
      </CardContent>
    </Card>
  </div>

  <Card>
    <CardHeader><CardTitle class="text-base">Variants</CardTitle></CardHeader>
    <CardContent>
      <ul class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
        {#each asset.variants as v (v.variant)}
          <li class="space-y-1 rounded-md border border-border p-2 text-xs">
            <p class="font-medium">{v.variant}</p>
            <p class="text-muted-foreground">
              {v.format}{v.width && v.height ? ` · ${v.width}×${v.height}` : ""}
            </p>
            <p class="text-muted-foreground">{fmtSize(v.sizeBytes)}</p>
            <a class="text-primary underline-offset-4 hover:underline" href={previewUrl(v.variant)} target="_blank" rel="noopener">Open ↗</a>
          </li>
        {/each}
      </ul>
    </CardContent>
  </Card>

  <Card>
    <CardHeader><CardTitle class="text-base">Used in</CardTitle></CardHeader>
    <CardContent>
      {#if data.referencingModules.length === 0}
        <p class="text-sm text-muted-foreground">Not yet referenced from any module.</p>
      {:else}
        <ul class="space-y-1 text-sm">
          {#each data.referencingModules as m (m.id)}
            <li>
              <a class="font-medium underline-offset-4 hover:underline" href={`/content/modules/${m.id}`}>
                {m.slug}
              </a>
              <span class="text-muted-foreground"> — {m.displayName}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </CardContent>
  </Card>

  <Card class="border-destructive/40">
    <CardHeader><CardTitle class="text-base text-destructive">Danger zone</CardTitle></CardHeader>
    <CardContent>
      <Button variant="destructive" onclick={() => (confirmDelete = true)}>
        <Trash2 class="mr-2 size-4" />
        Delete asset
      </Button>
    </CardContent>
  </Card>

  <Dialog open={confirmDelete} onOpenChange={(o) => (confirmDelete = o)}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Delete this asset?</DialogTitle>
        <DialogDescription>
          {#if data.referencingModules.length > 0}
            This asset is referenced from {data.referencingModules.length} module(s). Deleting will
            leave broken &lt;img&gt; URLs in those modules — fix them before publishing again.
          {:else}
            This asset is not referenced anywhere. Soft-delete is reversible from the audit log.
          {/if}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onclick={() => (confirmDelete = false)}>Cancel</Button>
        <form method="post" action="?/delete">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <input
            type="hidden"
            name="force"
            value={data.referencingModules.length > 0 ? "true" : "false"}
          />
          <Button type="submit" variant="destructive">Delete</Button>
        </form>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</div>
