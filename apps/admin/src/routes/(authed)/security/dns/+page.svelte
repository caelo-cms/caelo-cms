<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Globe } from "lucide-svelte";
  import { enhance } from "$app/forms";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";

  let { data, form } = $props();

  function fmtTime(s: string): string {
    return new Date(s).toLocaleString();
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <Globe class="size-6" />
      DNS records
    </h1>
    <p class="text-sm text-muted-foreground">
      Records the active provisioning stack expects you to publish at your registrar. The
      <code class="rounded bg-muted px-1">cms-provision pulumi-output-sync</code> step writes these
      after every <code class="rounded bg-muted px-1">pulumi up</code>. Click Verify on a row to run a
      live resolver check.
    </p>
  </div>

  {#if form?.error}
    <div class="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">
      {form.error}
    </div>
  {/if}
  {#if form?.ok && form?.verified}
    <div
      class="rounded border p-3 text-sm"
      class:border-green-200={form.verified.status === "ok"}
      class:bg-green-50={form.verified.status === "ok"}
      class:text-green-700={form.verified.status === "ok"}
      class:border-amber-200={form.verified.status === "pending"}
      class:bg-amber-50={form.verified.status === "pending"}
      class:text-amber-700={form.verified.status === "pending"}
      class:border-red-200={form.verified.status === "mismatch" || form.verified.status === "error"}
      class:bg-red-50={form.verified.status === "mismatch" || form.verified.status === "error"}
      class:text-red-700={form.verified.status === "mismatch" || form.verified.status === "error"}
    >
      <strong>{form.verified.hostname} ({form.verified.type})</strong>
      <span class="ml-2">→ {form.verified.status}</span>
      {#if form.verified.observed.length > 0}
        <div class="mt-1 font-mono text-xs">observed: {form.verified.observed.join(", ")}</div>
      {/if}
      {#if form.verified.message}
        <div class="mt-1 text-xs">{form.verified.message}</div>
      {/if}
    </div>
  {/if}

  {#if data.rows.length === 0}
    <Card>
      <CardHeader>
        <CardTitle>No provisioning snapshot yet</CardTitle>
        <CardDescription>
          Run <code class="rounded bg-muted px-1">cms-provision pulumi-output-sync</code> after a
          <code class="rounded bg-muted px-1">pulumi up</code> to populate this page with the records
          your provider stack requires.
        </CardDescription>
      </CardHeader>
    </Card>
  {/if}

  {#each data.rows as row (row.provider + ":" + row.environment)}
    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <span class="font-mono text-base">{row.provider}</span>
          <Badge variant="outline">{row.environment}</Badge>
        </CardTitle>
        <CardDescription>
          Last synced {fmtTime(row.syncedAt)} · hash {row.outputsHash.slice(0, 8)}
          {#if row.bootstrapUrl}
            · <a class="underline" href={row.bootstrapUrl}>bootstrap link</a>
          {/if}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {#if row.dnsRecordsRequired.length === 0}
          <p class="text-sm text-muted-foreground">No DNS records required for this stack.</p>
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b text-left">
                  <th class="py-2">Hostname</th>
                  <th class="py-2">Type</th>
                  <th class="py-2">Value</th>
                  <th class="py-2">Purpose</th>
                  <th class="py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {#each row.dnsRecordsRequired as rec (rec.hostname + rec.type + rec.value)}
                  <tr class="border-b last:border-0">
                    <td class="py-2 font-mono">{rec.hostname}</td>
                    <td class="py-2">
                      <Badge variant="outline">{rec.type}</Badge>
                    </td>
                    <td class="py-2 font-mono text-xs">{rec.value}</td>
                    <td class="py-2 text-muted-foreground">{rec.purpose}</td>
                    <td class="py-2 text-right">
                      <form method="post" action="?/verify" use:enhance class="inline-flex gap-2">
                        <input type="hidden" name="hostname" value={rec.hostname} />
                        <input type="hidden" name="type" value={rec.type} />
                        <input type="hidden" name="expectedValue" value={rec.value} />
                        <Button type="submit" size="sm" variant="outline">Verify</Button>
                      </form>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </CardContent>
    </Card>
  {/each}
</div>
