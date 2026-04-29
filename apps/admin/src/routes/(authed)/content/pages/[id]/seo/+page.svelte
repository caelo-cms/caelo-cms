<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P8 — per-page SEO panel. Edits the pages_seo sidecar via the
   * `pages_seo.set` op. Autofill / re-optimize flows live in the
   * AI chat (the `seo-autofill` / `seo-optimize` skills) — the
   * Autofill button below jumps the user to /content/chat with a
   * pre-seeded prompt; same for Re-optimize.
   */

  import MediaPicker from "$lib/components/MediaPicker.svelte";
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
  import { Select } from "$lib/components/ui/select/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";

  let { data, form } = $props();
  const page = data.page as { id: string; slug: string; title: string; locale: string };
  const seoData = data.seo as {
    metaDescription: string;
    ogImageAssetId: string | null;
    canonicalUrl: string | null;
    noindex: boolean;
    changefreq: string;
    priority: number;
    autofilledAt: string | null;
    optimizedAt: string | null;
  } | null;
  const seo = seoData ?? {
    metaDescription: "",
    ogImageAssetId: null,
    canonicalUrl: null,
    noindex: false,
    changefreq: "weekly",
    priority: 0.5,
    autofilledAt: null,
    optimizedAt: null,
  };

  let pickerOpen = $state(false);
  let ogImageAssetId = $state(seo.ogImageAssetId ?? "");

  function onOgPick(m: { url: string; alt: string }): void {
    // Picker URL is /_caelo/media/<id>/<variant> — extract the id.
    const m1 = m.url.match(/\/_caelo\/media\/([0-9a-f-]{36})\//);
    if (m1) ogImageAssetId = m1[1] as string;
    void m.alt;
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">SEO — {page.title}</h1>
    <p class="text-sm text-muted-foreground">
      Per-page meta description, canonical, OG image, robots flag.
      <a class="underline" href={`/content/pages/${page.id}`}>← Back to layout</a>
    </p>
    {#if seo.autofilledAt}
      <p class="text-xs text-muted-foreground">First-fill: {seo.autofilledAt.slice(0, 10)}</p>
    {/if}
    {#if seo.optimizedAt}
      <p class="text-xs text-muted-foreground">Last optimized: {seo.optimizedAt.slice(0, 10)}</p>
    {/if}
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>{form.message ?? "Saved."}</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">SEO fields</CardTitle>
      <CardDescription>Title is set on the page itself. Edit the rest here.</CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/save" class="space-y-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <input type="hidden" name="ogImageAssetId" value={ogImageAssetId} />

        <div class="space-y-2">
          <Label for="metaDescription">Meta description</Label>
          <Textarea
            id="metaDescription"
            name="metaDescription"
            rows={3}
            placeholder="One or two sentences (≤160 chars recommended)"
            value={seo.metaDescription}
          />
        </div>

        <div class="space-y-2">
          <Label>OG image</Label>
          <div class="flex items-center gap-3">
            {#if ogImageAssetId}
              <img
                src={`/_caelo/media/${ogImageAssetId}/webp-400`}
                alt="OG"
                class="h-16 w-28 rounded border border-border object-cover"
              />
              <code class="font-mono text-xs text-muted-foreground">{ogImageAssetId}</code>
              <Button type="button" size="sm" variant="ghost" onclick={() => (ogImageAssetId = "")}>Clear</Button>
            {:else}
              <p class="text-sm text-muted-foreground">No OG image selected.</p>
            {/if}
            <Button type="button" size="sm" variant="outline" onclick={() => (pickerOpen = true)}>Pick from media</Button>
          </div>
        </div>

        <div class="space-y-2">
          <Label for="canonicalUrl">Canonical URL (optional override)</Label>
          <Input
            id="canonicalUrl"
            name="canonicalUrl"
            type="url"
            placeholder="https://example.com/canonical-path"
            value={seo.canonicalUrl ?? ""}
          />
        </div>

        <div class="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div class="space-y-2">
            <Label for="changefreq">Changefreq</Label>
            <Select id="changefreq" name="changefreq">
              {#each ["always", "hourly", "daily", "weekly", "monthly", "yearly", "never"] as f (f)}
                <option value={f} selected={seo.changefreq === f}>{f}</option>
              {/each}
            </Select>
          </div>
          <div class="space-y-2">
            <Label for="priority">Priority</Label>
            <Input
              id="priority"
              name="priority"
              type="number"
              min="0"
              max="1"
              step="0.1"
              value={seo.priority}
            />
          </div>
          <div class="flex items-end gap-2">
            <input type="checkbox" id="noindex" name="noindex" checked={seo.noindex} />
            <Label for="noindex">noindex (excluded from sitemap)</Label>
          </div>
        </div>

        <div class="flex gap-2">
          <Button type="submit">Save SEO</Button>
          <a class={buttonVariants({ variant: "outline" })} href={`/content/chat?prompt=${encodeURIComponent(`Run seo-autofill on page ${page.slug}`)}`}>Autofill with AI</a>
          <a class={buttonVariants({ variant: "outline" })} href={`/content/chat?prompt=${encodeURIComponent(`Run seo-optimize on page ${page.slug} with this context: <paste keyword analysis here>`)}`}>Re-optimize with AI</a>
        </div>
      </form>
    </CardContent>
  </Card>

  <MediaPicker bind:open={pickerOpen} onPick={onOgPick} />
</div>
