<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { confirmSubmit } from "#lib/confirm.svelte.js";
  import { ExternalLink, KeyRound, ShieldCheck } from "lucide-svelte";
  import { enhance } from "$app/forms";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button, buttonVariants } from "#lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";
  import { Input } from "#lib/components/ui/input/index.js";

  let { data, form } = $props();
  const access = $derived(data.access);
  const s = $derived(data.access.settings);
  const creds = $derived(data.access.credentials);
</script>

<div class="space-y-6">
  <div>
    <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <ShieldCheck class="size-6" />
      Staging access
    </h1>
    <p class="text-sm text-muted-foreground">
      The staging site shows exactly what Publish live would ship, on its own host and marked
      <code>noindex</code>. Choose who may open it: admin users through "Open staging", and
      crawlers or tools (for example a searchVIU dev crawl) through basic auth, a secret header or
      their IP address. Any one enabled mode lets a request in.
    </p>
  </div>

  {#if form?.error}
    <div class="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">{form.error}</div>
  {/if}
  {#if form?.ok}
    <div class="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-700 dark:bg-green-950 dark:text-green-300">{form.message}</div>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle>Staging site</CardTitle>
      <CardDescription>
        {#if access.stagingUrl}
          <span class="font-mono">{access.stagingUrl}/</span> —
          {access.hasStagedBuild ? "serving the latest staged build" : "nothing staged right now"}.
          <a class="underline" href="/settings/domains">Change the host</a>.
        {:else if access.stagingDomainSupported}
          No staging host is configured yet — set it under
          <a class="underline" href="/settings/domains">Settings → Domains</a>.
        {:else}
          This install's provider ({access.provider}) has no protected staging domain yet; the Stage
          result links the staged build.
        {/if}
      </CardDescription>
    </CardHeader>
    {#if access.stagingUrl && (access.stageNeeded || access.draftPages.count > 0)}
      <CardContent class="space-y-2">
        {#if access.stageNeeded}
          <!-- #678 — a new host (or one changed since the last Stage) serves
               nothing / a stale build until the next Stage. -->
          <div class="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200" data-testid="staging-stage-needed">
            {access.stageNeeded === "nothing-staged"
              ? `Nothing is served at ${access.stagingUrl}/ until the next Stage.`
              : `The served build was rendered for ${access.stagedBuildHost} — Stage again so ${access.stagingUrl}/ gets its own canonicals, sitemap and robots.txt.`}
            Stage from the editor or <a class="underline" href="/content/changes">Open changes</a>.
          </div>
        {/if}
        {#if access.draftPages.count > 0}
          <div class="rounded border bg-muted/30 p-3 text-sm" data-testid="staging-draft-pages">
            {access.draftPages.count} page(s) are draft and are not staged:
            {access.draftPages.pages.map((p) => `${p.title} (${p.path})`).join(", ")}{access.draftPages.count > access.draftPages.pages.length ? ", …" : ""}.
            Only published pages reach staging — set them to published, then Stage.
          </div>
        {/if}
      </CardContent>
    {/if}
    {#if access.stagingUrl && s.cookieEnabled}
      <CardContent>
        <a
          href="/staging/open"
          target="_blank"
          rel="noopener noreferrer"
          class={buttonVariants({ variant: "outline" })}
          data-testid="open-staging"
        >
          <ExternalLink class="size-4" /> Open staging
        </a>
      </CardContent>
    {/if}
  </Card>

  <Card>
    <CardHeader>
      <CardTitle>Access modes</CardTitle>
      <CardDescription>Last changed {new Date(s.updatedAt).toLocaleString()}.</CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/save" use:enhance class="grid max-w-xl gap-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <label class="flex items-start gap-2 text-sm">
          <input type="checkbox" name="cookieEnabled" checked={s.cookieEnabled} disabled={!data.canWrite} />
          <span>
            <span class="font-medium">Open staging from the admin</span><br />
            <span class="text-muted-foreground">Admin users get a 12-hour staging session, no password.</span>
          </span>
        </label>
        <label class="flex items-start gap-2 text-sm">
          <input type="checkbox" name="basicAuthEnabled" checked={s.basicAuthEnabled} disabled={!data.canWrite} />
          <span>
            <span class="font-medium">Basic auth</span>
            {#if s.basicAuthEnabled && !s.basicAuthGenerated}<Badge variant="outline">no password yet</Badge>{/if}<br />
            <span class="text-muted-foreground">A generated password; the user name is below.</span>
          </span>
        </label>
        <label class="grid gap-1 text-sm">
          <span>Basic-auth user</span>
          <Input name="basicAuthUser" value={s.basicAuthUser} disabled={!data.canWrite} required />
        </label>
        <label class="flex items-start gap-2 text-sm">
          <input type="checkbox" name="headerEnabled" checked={s.headerEnabled} disabled={!data.canWrite} />
          <span>
            <span class="font-medium">Secret header</span><br />
            <span class="text-muted-foreground">Crawlers send a generated value in this request header.</span>
          </span>
        </label>
        <label class="grid gap-1 text-sm">
          <span>Header name</span>
          <Input name="headerName" value={s.headerName} disabled={!data.canWrite} required />
        </label>
        <label class="grid gap-1 text-sm">
          <span>IP allowlist</span>
          <textarea
            name="ipAllowlist"
            rows="3"
            class="rounded-md border bg-background p-2 font-mono text-sm"
            placeholder="203.0.113.7&#10;198.51.100.0/24"
            disabled={!data.canWrite}
          >{s.ipAllowlist.join("\n")}</textarea>
          <span class="text-xs text-muted-foreground">One address or CIDR per line (IPv4 or IPv6), e.g. a crawler's static egress IP.</span>
        </label>
        {#if data.canWrite}
          <div><Button type="submit">Save access modes</Button></div>
        {/if}
      </form>
    </CardContent>
  </Card>

  {#if creds}
    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2"><KeyRound class="size-4" /> Crawler credentials</CardTitle>
        <CardDescription>
          Generated, never stored in readable form, shown only to you. Give them only to the tool
          that crawls staging. Rotating locks out everything that uses the old value.
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4 text-sm">
        <div class="grid gap-1">
          <span class="font-medium">Basic auth</span>
          {#if creds.basicAuthPassword}
            <code class="rounded bg-muted p-2 break-all" data-testid="staging-basic-auth">{creds.basicAuthUser} / {creds.basicAuthPassword}</code>
          {:else}
            <span class="text-muted-foreground">Enable basic auth to generate a password.</span>
          {/if}
        </div>
        <div class="grid gap-1">
          <span class="font-medium">Secret header</span>
          {#if creds.headerValue}
            <code class="rounded bg-muted p-2 break-all">{creds.headerName}: {creds.headerValue}</code>
          {:else}
            <span class="text-muted-foreground">Enable the secret header to generate a value.</span>
          {/if}
        </div>
        <div class="rounded border bg-muted/30 p-3 text-xs text-muted-foreground">
          searchVIU dev crawl: <code>dev_auth_type: "PW"</code> with <code>dev_auth_user</code> /
          <code>dev_auth_pw</code> from basic auth, or <code>dev_auth_type: "IP"</code> with the
          crawler's static egress IP in the allowlist; a header goes into
          <code>additional_headers</code>. Set <code>ignore_robots_tag_noindex: true</code> —
          staging is always <code>noindex</code>.
        </div>
        <div class="flex flex-wrap gap-2">
          {#each [["basic-auth", "Rotate basic-auth password"], ["header", "Rotate header value"]] as [which, label] (which)}
            <form method="post" action="?/rotate" use:enhance use:confirmSubmit={{ title: `${label}?`, description: "Everyone using the current value, including crawlers, loses access to staging until they get the new one.", confirmLabel: "Rotate" }}>
              <input type="hidden" name="_csrf" value={data.csrfToken} />
              <input type="hidden" name="which" value={which} />
              <Button type="submit" variant="destructive">{label}</Button>
            </form>
          {/each}
        </div>
      </CardContent>
    </Card>
  {/if}
</div>
