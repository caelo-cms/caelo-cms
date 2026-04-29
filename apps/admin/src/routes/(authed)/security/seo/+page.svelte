<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
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

  let { data, form } = $props();
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">SEO settings</h1>
    <p class="text-sm text-muted-foreground">
      Site-level base URL, sitemap toggle, Organization JSON-LD, and the stale-SEO queue.
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>{form.message ?? "Saved."}</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Site defaults</CardTitle>
      <CardDescription>
        The base URL shows up in canonical tags + sitemap entries. Organization JSON-LD wraps every
        page's WebPage schema as the publisher.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/saveSettings" class="space-y-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <div class="space-y-2">
          <Label for="siteBaseUrl">Site base URL</Label>
          <Input
            id="siteBaseUrl"
            name="siteBaseUrl"
            type="url"
            required
            value={data.settings.siteBaseUrl}
          />
        </div>
        <div class="flex items-center gap-2">
          <input
            type="checkbox"
            id="sitemapEnabled"
            name="sitemapEnabled"
            checked={data.settings.sitemapEnabled}
          />
          <Label for="sitemapEnabled">Emit sitemap.xml on production deploys</Label>
        </div>
        <div class="space-y-2">
          <Label for="organizationJson">Organization JSON</Label>
          <Textarea
            id="organizationJson"
            name="organizationJson"
            rows={6}
            class="font-mono text-xs"
            value={JSON.stringify(data.settings.organizationJson, null, 2)}
          />
          <p class="text-xs text-muted-foreground">
            Shape: <code class="font-mono">{`{"name", "url", "logo", "sameAs": [...]}`}</code>.
          </p>
        </div>
        <Button type="submit">Save settings</Button>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Stale SEO ({data.stale.length})</CardTitle>
      <CardDescription>
        Pages with empty meta description or that have never been re-optimized. Click to open the
        per-page panel.
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.stale.length === 0}
        <p class="text-sm text-muted-foreground">All pages have SEO populated and have been optimized at least once.</p>
      {:else}
        <ul class="space-y-1 text-sm">
          {#each data.stale as p (p.pageId)}
            <li>
              <a class="font-medium underline-offset-4 hover:underline" href={`/content/pages/${p.pageId}/seo`}>
                {p.slug}
              </a>
              <span class="text-muted-foreground"> — {p.title}</span>
              {#if !p.autofilledAt}
                <span class="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900 dark:bg-amber-900/30 dark:text-amber-100">unfilled</span>
              {:else if !p.optimizedAt}
                <span class="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-900 dark:bg-blue-900/30 dark:text-blue-100">never optimized</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </CardContent>
  </Card>
</div>
