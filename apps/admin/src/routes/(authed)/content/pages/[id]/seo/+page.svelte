<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P8 — per-page SEO panel. Edits the pages_seo sidecar via the
   * `pages_seo.set` op. Autofill / re-optimize flows live in the
   * AI chat (the `seo-autofill` / `seo-optimize` skills) — the
   * Autofill button below jumps the user to /content/chat with a
   * pre-seeded prompt; same for Re-optimize.
   *
   * #1752 — the page's own SEO title and Open Graph texts, the robots
   * directives, and for every value what a build renders and where it
   * comes from (the page itself, its page type's or the site's title
   * template, or shared from another value). An AI-written text can be
   * marked reviewed here; editing a text makes it the person's own.
   */

  import { buildMediaUrl } from "@caelo-cms/shared";
  import MediaPicker from "#lib/components/MediaPicker.svelte";
  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Select } from "#lib/components/ui/select/index.js";
  import { Textarea } from "#lib/components/ui/textarea/index.js";
  import { type SeoOriginValue, seoOriginText } from "#lib/seo-origin.js";

  type TextField = "seoTitle" | "metaDescription" | "ogTitle" | "ogDescription";

  let { data, form } = $props();
  const page = data.page as { id: string; slug: string; title: string };
  const seoData = data.seo as {
    seoTitle: string;
    metaDescription: string;
    ogTitle: string;
    ogDescription: string;
    ogImageAssetId: string | null;
    canonicalUrl: string | null;
    noindex: boolean;
    nofollow: boolean;
    noarchive: boolean;
    nosnippet: boolean;
    noimageindex: boolean;
    maxSnippet: number | null;
    maxImagePreview: "none" | "standard" | "large";
    maxVideoPreview: number | null;
    origins: Partial<Record<TextField, "human" | "ai" | "reviewed">>;
    changefreq: string;
    priority: number;
    autofilledAt: string | null;
    optimizedAt: string | null;
  } | null;
  // A page without a row reads as the column defaults (pages_seo), as the build reads it.
  const seo = seoData ?? {
    seoTitle: "",
    metaDescription: "",
    ogTitle: "",
    ogDescription: "",
    ogImageAssetId: null,
    canonicalUrl: null,
    noindex: false,
    nofollow: false,
    noarchive: false,
    nosnippet: false,
    noimageindex: false,
    maxSnippet: null,
    maxImagePreview: "large" as const,
    maxVideoPreview: null,
    origins: {},
    changefreq: "weekly",
    priority: 0.5,
    autofilledAt: null,
    optimizedAt: null,
  };
  const resolved = data.resolved as {
    title: SeoOriginValue;
    metaDescription: SeoOriginValue;
    ogTitle: SeoOriginValue;
    ogDescription: SeoOriginValue;
    ogType: SeoOriginValue;
    robots: string;
    pageType: string;
  } | null;

  /** What renders while a text field is empty (the template or the shared value). */
  const emptyMeans: Record<TextField, string> = {
    seoTitle:
      resolved && resolved.title.origin !== "human" && resolved.title.template
        ? `Empty: the title template renders "${resolved.title.template}"`
        : "Empty: the title template of this page's type renders",
    metaDescription: "One or two sentences for a search result",
    ogTitle: "Empty: same as the SEO title, else the page title",
    ogDescription: "Empty: same as the meta description",
  };

  const textFields: { field: TextField; label: string; rows: number }[] = [
    { field: "seoTitle", label: "SEO title (search results)", rows: 1 },
    { field: "metaDescription", label: "Meta description", rows: 3 },
    { field: "ogTitle", label: "Social share title (og:title)", rows: 1 },
    { field: "ogDescription", label: "Social share description (og:description)", rows: 2 },
  ];

  const resolvedRows = $derived(
    resolved === null
      ? []
      : [
          { label: "Title", v: resolved.title },
          { label: "Meta description", v: resolved.metaDescription },
          { label: "Social share title", v: resolved.ogTitle },
          { label: "Social share description", v: resolved.ogDescription },
          { label: "Shared as (og:type)", v: resolved.ogType },
        ],
  );

  let pickerOpen = $state(false);
  // Persisted value is the asset id (pages_seo stores the id ref); the
  // preview URL is slug-based and display-only.
  let ogImageAssetId = $state(seo.ogImageAssetId ?? "");
  let ogImagePreviewUrl = $state(
    data.ogImageSlug ? buildMediaUrl(data.ogImageSlug, "webp-400") : "",
  );

  function onOgPick(m: { url: string; alt: string; mediaId: string }): void {
    ogImageAssetId = m.mediaId;
    ogImagePreviewUrl = m.url;
    void m.alt;
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">SEO — {page.title}</h1>
    <p class="text-sm text-muted-foreground">
      Title, descriptions, social sharing and search engine rules of this page.
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

  {#if resolved}
    <Card>
      <CardHeader>
        <CardTitle class="text-base">What the page shows</CardTitle>
        <CardDescription>
          As the next Stage renders it, and where each value comes from.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl class="divide-y" data-testid="seo-resolved">
          {#each resolvedRows as row (row.label)}
            <div class="py-2">
              <dt class="text-xs font-medium text-muted-foreground">{row.label}</dt>
              <dd class="mt-0.5 break-words text-sm">{row.v.value || "None"}</dd>
              {#if seoOriginText(row.v, resolved.pageType)}
                <dd class="mt-0.5 text-xs text-muted-foreground" data-testid="seo-origin">
                  {seoOriginText(row.v, resolved.pageType)}
                </dd>
              {/if}
            </div>
          {/each}
          <div class="py-2">
            <dt class="text-xs font-medium text-muted-foreground">Search engine rules</dt>
            <dd class="mt-0.5 font-mono text-xs">{resolved.robots}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">SEO fields</CardTitle>
      <CardDescription>
        The page title is set on the page itself. An empty field here uses the template or the
        value it shares.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/save" class="space-y-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <input type="hidden" name="ogImageAssetId" value={ogImageAssetId} />

        {#each textFields as t (t.field)}
          <div class="space-y-2">
            <Label for={t.field}>{t.label}</Label>
            {#if t.rows === 1}
              <Input id={t.field} name={t.field} placeholder={emptyMeans[t.field]} value={seo[t.field]} />
            {:else}
              <Textarea
                id={t.field}
                name={t.field}
                rows={t.rows}
                placeholder={emptyMeans[t.field]}
                value={seo[t.field]}
              />
            {/if}
            {#if seo.origins[t.field] === "ai"}
              <div class="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  id={`reviewed-${t.field}`}
                  name="reviewed"
                  value={t.field}
                  data-testid={`seo-reviewed-${t.field}`}
                />
                <Label for={`reviewed-${t.field}`} class="text-xs font-normal">
                  Written by the AI — I reviewed it and keep it
                </Label>
              </div>
            {:else if seo.origins[t.field] === "reviewed"}
              <p class="text-xs text-muted-foreground">Written by the AI, reviewed by a person.</p>
            {/if}
          </div>
        {/each}

        <div class="space-y-2">
          <Label>OG image</Label>
          <div class="flex items-center gap-3">
            {#if ogImageAssetId}
              <img
                src={ogImagePreviewUrl}
                alt="OG"
                class="h-16 w-28 rounded border border-border object-cover"
              />
              <code class="font-mono text-xs text-muted-foreground">{ogImageAssetId}</code>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onclick={() => {
                  ogImageAssetId = "";
                  ogImagePreviewUrl = "";
                }}>Clear</Button
              >
            {:else}
              <p class="text-sm text-muted-foreground" data-testid="seo-og-default">
                {#if data.shareImage && data.shareImage.source !== "none" && data.shareImage.url === null}
                  No own image, and the default image was deleted. A Stage stops until another one
                  is chosen.
                {:else if data.shareImage?.source === "language"}
                  No own image: links show this language's default image.
                {:else if data.shareImage?.source === "site"}
                  No own image: links show the site's default image.
                {:else}
                  No OG image selected.
                {/if}
              </p>
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

        <fieldset class="space-y-3 rounded-md border p-3">
          <legend class="px-1 text-sm font-medium">Search engine rules</legend>
          <div class="grid grid-cols-1 gap-2 md:grid-cols-2">
            {#each [
              { name: "noindex", label: "Keep out of search results (noindex, also out of the sitemap)", checked: seo.noindex },
              { name: "nofollow", label: "Do not follow this page's links (nofollow)", checked: seo.nofollow },
              { name: "nosnippet", label: "No text snippet, also not in AI answers (nosnippet)", checked: seo.nosnippet },
              { name: "noarchive", label: "No cached copy (noarchive)", checked: seo.noarchive },
              { name: "noimageindex", label: "Do not index this page's images (noimageindex)", checked: seo.noimageindex },
            ] as d (d.name)}
              <div class="flex items-start gap-2">
                <input type="checkbox" id={d.name} name={d.name} checked={d.checked} class="mt-1" />
                <Label for={d.name} class="font-normal">{d.label}</Label>
              </div>
            {/each}
          </div>
          <div class="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div class="space-y-2">
              <Label for="maxSnippet">Longest snippet (characters)</Label>
              <Input
                id="maxSnippet"
                name="maxSnippet"
                type="number"
                min="-1"
                max="100000"
                placeholder="No limit set"
                value={seo.maxSnippet ?? ""}
              />
            </div>
            <div class="space-y-2">
              <Label for="maxImagePreview">Image preview size</Label>
              <Select id="maxImagePreview" name="maxImagePreview">
                {#each ["large", "standard", "none"] as v (v)}
                  <option value={v} selected={seo.maxImagePreview === v}>{v}</option>
                {/each}
              </Select>
            </div>
            <div class="space-y-2">
              <Label for="maxVideoPreview">Longest video preview (seconds)</Label>
              <Input
                id="maxVideoPreview"
                name="maxVideoPreview"
                type="number"
                min="-1"
                max="86400"
                placeholder="No limit set"
                value={seo.maxVideoPreview ?? ""}
              />
            </div>
          </div>
          <p class="text-xs text-muted-foreground">-1 means no limit, 0 means none.</p>
        </fieldset>

        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
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
        </div>

        <div class="flex gap-2">
          <Button type="submit">Save SEO</Button>
        </div>
      </form>

      <!-- P8 review-pass: Autofill / Re-optimize POST to the chat
           index's create action with a `prompt` field; the action
           creates a session and redirects to /content/chat/<id>?prompt=
           which seeds the composer via the existing
           caelo:insert-into-composer CustomEvent. -->
      <div class="mt-4 flex gap-2">
        <form method="post" action="/content/chat?/create">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <input
            type="hidden"
            name="prompt"
            value={`Run seo-autofill on page ${page.slug}`}
          />
          <Button type="submit" variant="outline">Autofill with AI</Button>
        </form>
        <form method="post" action="/content/chat?/create">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <input
            type="hidden"
            name="prompt"
            value={`Run seo-optimize on page ${page.slug} with this context: <paste keyword analysis here>`}
          />
          <Button type="submit" variant="outline">Re-optimize with AI</Button>
        </form>
      </div>
    </CardContent>
  </Card>

  <MediaPicker bind:open={pickerOpen} onPick={onOgPick} />
</div>
