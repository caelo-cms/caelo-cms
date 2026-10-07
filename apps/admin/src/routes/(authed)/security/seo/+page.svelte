<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

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
  import { Textarea } from "#lib/components/ui/textarea/index.js";

  let { data, form } = $props();
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">SEO settings</h1>
    <p class="text-sm text-muted-foreground">
      Site-level base URL, sitemap toggle, Organization JSON-LD, site language, and the stale-SEO queue.
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>{form.message ?? "Saved."}</AlertDescription></Alert>
  {/if}

  {#if data.pendingError}
    <Alert variant="destructive"><AlertDescription>{data.pendingError}</AlertDescription></Alert>
  {/if}
  {#if data.pendingProposals.length > 0}
    <Card data-testid="seo-pending-proposals">
      <CardHeader>
        <CardTitle class="text-base">Proposed by the AI ({data.pendingProposals.length})</CardTitle>
        <CardDescription>
          Changes the AI prepared for these settings. Nothing changes until you approve.
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        {#each data.pendingProposals as p (p.id)}
          <div class="space-y-2 rounded border p-3 text-sm">
            <ul class="space-y-1">
              {#each Object.entries(p.preview.changes ?? {}) as [field, change] (field)}
                <li>
                  <span class="font-medium">{field}</span>:
                  <code class="font-mono text-xs">{JSON.stringify(change.from)}</code>
                  →
                  <code class="font-mono text-xs">{JSON.stringify(change.to)}</code>
                </li>
              {/each}
            </ul>
            <p class="text-xs text-muted-foreground">
              proposed {new Date(p.createdAt).toISOString().slice(0, 19)}Z
            </p>
            <div class="flex items-center gap-2">
              <form method="post" action="?/approveProposal">
                <input type="hidden" name="_csrf" value={data.csrfToken} />
                <input type="hidden" name="proposalId" value={p.id} />
                <Button type="submit">Approve</Button>
              </form>
              <form method="post" action="?/rejectProposal" class="flex items-center gap-2">
                <input type="hidden" name="_csrf" value={data.csrfToken} />
                <input type="hidden" name="proposalId" value={p.id} />
                <Input name="reason" placeholder="reject reason (optional)" class="h-8 text-xs" />
                <Button type="submit" variant="ghost">Reject</Button>
              </form>
            </div>
          </div>
        {/each}
      </CardContent>
    </Card>
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
            placeholder="https://example.com"
            value={data.settings.siteBaseUrl ?? ""}
          />
          {#if data.settings.siteBaseUrl === null}
            <Alert variant="destructive" data-testid="site-base-url-unset">
              <AlertDescription>
                Not set yet. Publishing fails until it is: canonical links, the sitemap and
                social previews all need your site's public address. Enter it here, or tell the AI
                in the editor chat your domain and approve its proposal.
              </AlertDescription>
            </Alert>
          {/if}
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
      <CardTitle class="text-base">Site language</CardTitle>
      <CardDescription>
        The language your content is written in, as a BCP 47 tag (<code class="font-mono">en</code>,
        <code class="font-mono">de</code>, <code class="font-mono">pt-BR</code>). Every page carries it
        as <code class="font-mono">&lt;html lang&gt;</code> so screen readers and search engines read
        it correctly. With the international-site plugin active, translated pages carry their own
        locale instead.
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.siteLanguageError}
        <Alert variant="destructive"><AlertDescription>{data.siteLanguageError}</AlertDescription></Alert>
      {:else}
        <form method="post" action="?/saveLanguage" class="flex items-end gap-2">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <div class="space-y-2">
            <Label for="siteLanguage">Language tag</Label>
            <Input
              id="siteLanguage"
              name="siteLanguage"
              required
              maxlength={35}
              pattern={"[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*"}
              placeholder="en"
              value={data.siteLanguage ?? ""}
            />
          </div>
          <Button type="submit">Save language</Button>
        </form>
        {#if data.siteLanguage === null}
          <Alert variant="destructive" class="mt-4" data-testid="site-language-unset">
            <AlertDescription>
              Not set yet. Publishing fails until it is: every page needs its language for screen
              readers and search engines. Tell the AI in the editor chat which language your site is
              written in, or enter the tag here.
            </AlertDescription>
          </Alert>
        {/if}
      {/if}
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
