<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P9 — locale registry + Advanced URL Routing toggle. AI-proposed
   * locale changes land in /security/locales/pending for the Owner to
   * Approve. Direct edits happen at /security/locales/[code].
   */

  import { Globe } from "lucide-svelte";
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/components/ui/table/index.js";

  let { data, form } = $props();
  const csrfToken = $derived(
    typeof window === "undefined" ? "" : (document.cookie.match(/caelo_csrf=([^;]+)/)?.[1] ?? ""),
  );
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Locales &amp; URL routing</h1>
    <p class="text-sm text-muted-foreground">
      Languages this site supports + how each locale's URL is shaped. Adding / removing /
      retargeting a locale is two-step: AI queues the change, an Owner clicks Approve at
      <a href="/security/locales/pending" class="underline">the pending queue</a>.
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>{form.message ?? "Saved."}</AlertDescription></Alert>
  {/if}

  {#if data.lintWarnings.length > 0}
    <Card>
      <CardHeader>
        <CardTitle class="text-base">Configuration warnings</CardTitle>
      </CardHeader>
      <CardContent>
        <ul class="space-y-1 text-sm">
          {#each data.lintWarnings as w (w.code)}
            <li class="text-yellow-700 dark:text-yellow-400">⚠ {w.message}</li>
          {/each}
        </ul>
      </CardContent>
    </Card>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Advanced URL routing</CardTitle>
      <CardDescription>
        When off, only no-prefix and subdirectory strategies are usable — the simplest setup. Turn
        on to expose subdomain (de.example.com) and separate domain (example.de) for locales that
        need them. Subdomain / domain require SSL + DNS + CDN configuration.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/toggleAdvanced" class="flex items-center gap-4">
        <input type="hidden" name="_csrf" value={csrfToken} />
        <label class="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="advancedUrlRouting"
            checked={data.settings.advancedUrlRouting}
          />
          Enable subdomain / domain strategies
        </label>
        <Button type="submit" size="sm" variant="outline">Save</Button>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Locales</CardTitle>
      <CardDescription>
        {data.locales.length}
        {data.locales.length === 1 ? "locale" : "locales"} active. The default locale is unmoveable
        until you set a different one as default.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Code</TableHead>
            <TableHead>Display name</TableHead>
            <TableHead>URL strategy</TableHead>
            <TableHead>Host</TableHead>
            <TableHead>Default</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each data.locales as l (l.code)}
            <TableRow>
              <TableCell class="font-mono">{l.code}</TableCell>
              <TableCell>{l.displayName}</TableCell>
              <TableCell>{l.urlStrategy}</TableCell>
              <TableCell class="font-mono text-xs">{l.urlHost ?? ""}</TableCell>
              <TableCell>{l.isDefault ? "yes" : ""}</TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="flex items-center gap-2 text-base">
        <Globe class="size-4" />
        Pending proposals ({data.pendingProposals.length})
      </CardTitle>
      <CardDescription>
        AI-queued locale changes. Click through to <a
          href="/security/locales/pending"
          class="underline">the pending queue</a
        > to Approve or Reject.
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.pendingProposals.length === 0}
        <p class="text-sm text-muted-foreground">No pending proposals.</p>
      {:else}
        <ul class="space-y-1 text-sm">
          {#each data.pendingProposals as p (p.id)}
            <li>
              <code class="font-mono">{p.actionKind}</code> — {JSON.stringify(p.payload)}
            </li>
          {/each}
        </ul>
      {/if}
    </CardContent>
  </Card>
</div>
