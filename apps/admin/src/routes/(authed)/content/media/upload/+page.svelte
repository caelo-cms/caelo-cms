<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P7 — media upload form. Drag/drop zone + file picker + alt text.
   * POSTs multipart to `/api/media/upload`; redirects to the new
   * asset's detail page on success.
   */

  import { Upload } from "lucide-svelte";
  import { goto } from "$app/navigation";
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Button, buttonVariants } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";

  let selected = $state<File | null>(null);
  let alt = $state("");
  let dragActive = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  function pick(files: FileList | null): void {
    if (!files || files.length === 0) return;
    selected = files[0] ?? null;
    error = null;
  }

  async function submit(): Promise<void> {
    if (!selected) return;
    busy = true;
    error = null;
    try {
      const fd = new FormData();
      fd.set("file", selected);
      fd.set("alt", alt);
      const res = await fetch("/api/media/upload", { method: "POST", body: fd });
      if (!res.ok) {
        const text = await res.text();
        error = `Upload failed (${res.status}): ${text}`;
        busy = false;
        return;
      }
      const json = (await res.json()) as { assetId: string };
      await goto(`/content/media/${json.assetId}`);
    } catch (e) {
      error = `Upload failed: ${e instanceof Error ? e.message : String(e)}`;
      busy = false;
    }
  }
</script>

<div class="mx-auto max-w-2xl space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Upload media</h1>
    <p class="text-sm text-muted-foreground">
      Images get WebP variants generated on the fly. PDFs, SVGs, and video upload as-is.
    </p>
  </div>

  {#if error}
    <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">File</CardTitle>
      <CardDescription>Max 50 MB; per-format caps apply.</CardDescription>
    </CardHeader>
    <CardContent>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        role="button"
        tabindex="0"
        class="flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-border p-8 text-center transition-colors motion-reduce:transition-none"
        class:bg-accent={dragActive}
        ondragover={(e) => {
          e.preventDefault();
          dragActive = true;
        }}
        ondragleave={() => (dragActive = false)}
        ondrop={(e) => {
          e.preventDefault();
          dragActive = false;
          pick(e.dataTransfer?.files ?? null);
        }}
      >
        <Upload class="size-6 text-muted-foreground" />
        {#if selected}
          <p class="text-sm font-medium">{selected.name}</p>
          <p class="text-xs text-muted-foreground">
            {(selected.size / 1024).toFixed(0)} KB · {selected.type || "unknown"}
          </p>
        {:else}
          <p class="text-sm">Drop a file here, or</p>
        {/if}
        <Input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/avif,image/gif,image/svg+xml,application/pdf,video/mp4"
          onchange={(e) => pick((e.currentTarget as HTMLInputElement).files)}
        />
      </div>

      <div class="mt-4 space-y-2">
        <Label for="alt">Alt text</Label>
        <Textarea
          id="alt"
          rows={2}
          placeholder="Describe the asset for screen readers and search."
          value={alt}
          oninput={(e) => (alt = (e.currentTarget as HTMLTextAreaElement).value)}
        />
      </div>

      <div class="mt-4 flex gap-2">
        <Button onclick={submit} disabled={!selected || busy}>
          {busy ? "Uploading…" : "Upload"}
        </Button>
        <a href="/content/media" class={buttonVariants({ variant: "ghost" })}>Cancel</a>
      </div>
    </CardContent>
  </Card>
</div>
