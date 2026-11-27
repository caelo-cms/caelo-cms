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
      Site-level base URL, sitemap, feed and IndexNow, Organization JSON-LD, robots.txt rules, site
      language, and the stale-SEO queue.
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
  {#if data.settingsError}
    <Alert variant="destructive"><AlertDescription>{data.settingsError}</AlertDescription></Alert>
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
              <form method="post" action="?/approve">
                <input type="hidden" name="_csrf" value={data.csrfToken} />
                <input type="hidden" name="proposalId" value={p.id} />
                <Button type="submit">Approve</Button>
              </form>
              <form method="post" action="?/reject" class="flex items-center gap-2">
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
        <div class="space-y-1">
          <div class="flex items-center gap-2">
            <input
              type="checkbox"
              id="feedEnabled"
              name="feedEnabled"
              checked={data.settings.feedEnabled}
            />
            <Label for="feedEnabled">Publish a feed of the latest changes (/feed.xml)</Label>
          </div>
          <p class="pl-6 text-xs text-muted-foreground">
            Lists the pages whose content changed last, with the date it changed, and links it from
            every page. After every Publish live the feed's hub is told, so search engines and feed
            readers learn of the change right away.
          </p>
        </div>
        <div class="space-y-1">
          <div class="flex items-center gap-2">
            <input
              type="checkbox"
              id="indexNowEnabled"
              name="indexNowEnabled"
              checked={data.settings.indexNowEnabled}
            />
            <Label for="indexNowEnabled">Tell IndexNow search engines what changed</Label>
          </div>
          <p class="pl-6 text-xs text-muted-foreground">
            After every Publish live the changed addresses go to IndexNow, which Bing, Yandex,
            Seznam, Naver and Yep share. Google does not take part; it reads the sitemap and the
            feed.
          </p>
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

  <Card data-testid="robots-rules">
    <CardHeader>
      <CardTitle class="text-base">robots.txt rules</CardTitle>
      <CardDescription>
        Pages or crawlers to keep out, one group per crawler: <code class="font-mono">User-agent</code>
        lines, an optional <code class="font-mono">Content-Signal</code> line (search, ai-input,
        ai-train = yes or no), then <code class="font-mono">Allow</code> and
        <code class="font-mono">Disallow</code> paths
        (<code class="font-mono">*</code> matches anything, a closing <code class="font-mono">$</code> ends
        the match). Disallow stops crawling, not indexing: a page that must disappear from search keeps
        noindex. Saved rules reach the live site with the next Stage and Publish live; staging keeps
        every crawler out.
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-4">
      {#each data.settings.robotsWarnings as warning (warning)}
        <Alert variant="destructive"><AlertDescription>{warning}</AlertDescription></Alert>
      {/each}
      {#each data.settings.robotsNotes as note (note)}
        <Alert data-testid="robots-note"><AlertDescription>{note}</AlertDescription></Alert>
      {/each}
      <form method="post" action="?/saveRobots" class="space-y-2">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <Label for="robotsRules">Rules</Label>
        <Textarea
          id="robotsRules"
          name="robotsRules"
          rows={6}
          class="font-mono text-xs"
          placeholder={"User-agent: *\nDisallow: /search/"}
          value={form?.robotsRulesText ?? data.robotsRulesText}
        />
        <Button type="submit">Save robots.txt rules</Button>
      </form>
      {#if data.settings.robotsTxt !== null}
        <div class="space-y-1">
          <p class="text-xs text-muted-foreground">The live site's robots.txt after the next Publish live:</p>
          <pre class="overflow-x-auto rounded border bg-muted p-3 font-mono text-xs" data-testid="robots-txt-preview">{data.settings.robotsTxt}</pre>
        </div>
      {/if}
    </CardContent>
  </Card>

  <Card data-testid="search-notifications">
    <CardHeader>
      <CardTitle class="text-base">Search engine notifications</CardTitle>
      <CardDescription>
        What the last Publish lives told search engines. Failed sends are retried automatically.
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.settings.searchNotifications.length === 0}
        <p class="text-sm text-muted-foreground">
          None yet: they are sent after the next Publish live that changes a page.
        </p>
      {:else}
        <ul class="space-y-1 text-sm">
          {#each data.settings.searchNotifications as n (n.id)}
            <li>
              <span class="font-medium">{n.channel === "websub" ? "Feed hub (WebSub)" : "IndexNow"}</span>
              <span class="text-muted-foreground">
                — {n.status === "sent"
                  ? "sent"
                  : n.status === "pending"
                    ? "waiting to be sent"
                    : n.status === "skipped"
                      ? "not sent"
                      : "failed"}{n.channel === "indexnow" ? `, ${n.urlCount} addresses` : ""},
                {new Date(n.createdAt).toISOString().slice(0, 16).replace("T", " ")} UTC
              </span>
              {#if n.detail}
                <p class="text-xs text-muted-foreground">{n.detail}</p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Page titles</CardTitle>
      <CardDescription>
        The title search results show for a page without its own SEO title, unless its page type
        has a template of its own. Use <code class="font-mono">{"{page_title}"}</code>,
        <code class="font-mono">{"{short_title}"}</code> and
        <code class="font-mono">{"{site_name}"}</code>, for example
        <code class="font-mono">{"{page_title} | {site_name}"}</code>.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/saveTitleTemplate" class="flex items-end gap-2">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <div class="flex-1 space-y-2">
          <Label for="titleTemplate">Title template</Label>
          <Input
            id="titleTemplate"
            name="titleTemplate"
            required
            maxlength={200}
            value={data.settings.titleTemplate}
            data-testid="site-title-template"
          />
        </div>
        <Button type="submit">Save template</Button>
      </form>
      {#if data.settings.siteName === null && data.settings.titleTemplate.includes("{site_name}")}
        <Alert variant="destructive" class="mt-4">
          <AlertDescription>
            The site has no name yet, so titles show {"{site_name}"} as it is. Tell the AI the
            site's name in the editor chat.
          </AlertDescription>
        </Alert>
      {/if}
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
                <span class="ml-2 rounded bg-link/10 px-1.5 py-0.5 text-xs text-link">never optimized</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </CardContent>
  </Card>
</div>
