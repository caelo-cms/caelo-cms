<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P10 — translation dashboard advanced drawer. Per-locale bulk runs;
   * per-job cap raises; full job history. Granular controls live here
   * so the main dashboard stays one-button-per-row (UX-5).
   */

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

  let { data, form } = $props();
  const csrfToken = $derived(
    typeof window === "undefined" ? "" : (document.cookie.match(/caelo_csrf=([^;]+)/)?.[1] ?? ""),
  );
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Translations — advanced</h1>
    <p class="text-sm text-muted-foreground">
      Per-locale bulk runs, per-job cost cap controls, full job history. Most editors should use
      the main <a href="/content/translations" class="underline">translations dashboard</a>.
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
      <CardTitle class="text-base">Per-locale bulk</CardTitle>
      <CardDescription>
        Queue a job that translates every stale page into one specific locale.
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-2">
      {#each data.locales.filter((l) => !l.isDefault) as locale (locale.code)}
        <form method="post" action="?/bulkLocale" class="flex items-center gap-2">
          <input type="hidden" name="_csrf" value={csrfToken} />
          <input type="hidden" name="code" value={locale.code} />
          <span class="font-mono text-sm w-12">{locale.code}</span>
          <span class="text-sm">{locale.displayName}</span>
          <Button type="submit" size="sm" variant="outline" class="ml-auto">
            Queue translations for {locale.code}
          </Button>
        </form>
      {/each}
      {#if data.locales.filter((l) => !l.isDefault).length === 0}
        <p class="text-sm text-muted-foreground">
          No non-default locales configured. Add one at <a href="/security/locales" class="underline"
            >/security/locales</a
          >.
        </p>
      {/if}
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Job history</CardTitle>
      <CardDescription>
        Most recent {data.jobs.length} job{data.jobs.length === 1 ? "" : "s"}. Raise the cap on a
        paused job to resume it.
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-3">
      {#if data.jobs.length === 0}
        <p class="text-sm text-muted-foreground">No jobs yet.</p>
      {/if}
      {#each data.jobs as j (j.id)}
        <div class="rounded border p-3 text-sm">
          <div class="flex items-center justify-between">
            <code class="font-mono text-xs">{j.id.slice(0, 8)}</code>
            <span class="text-xs text-muted-foreground">{j.status}</span>
          </div>
          <p class="mt-1">
            {j.completedUnits}/{j.totalUnits} done · {j.erroredUnits} errored · cost
            {(j.costMicrocents / 1e8).toFixed(4)} USD
            {#if j.capMicrocents !== null}
              · cap {(j.capMicrocents / 1e8).toFixed(4)} USD
            {/if}
          </p>
          {#if j.errorSummary}
            <p class="mt-1 text-xs text-yellow-700 dark:text-yellow-400">
              ⚠ {j.errorSummary}
            </p>
          {/if}
          {#if j.status === "paused" || j.status === "running" || j.status === "pending"}
            <form method="post" action="?/updateCap" class="mt-2 flex items-center gap-2">
              <input type="hidden" name="_csrf" value={csrfToken} />
              <input type="hidden" name="jobId" value={j.id} />
              <Label for={`cap-${j.id}`} class="text-xs">New cap (USD):</Label>
              <Input
                id={`cap-${j.id}`}
                type="number"
                step="0.01"
                min={0}
                name="capUsd"
                placeholder="leave blank for no cap"
                class="h-7 w-32 text-xs"
              />
              <Button type="submit" size="sm" variant="outline">Update</Button>
            </form>
          {/if}
          {#if j.status === "completed" && j.completedUnits > 0}
            <form method="post" action="?/revertJob" class="mt-2">
              <input type="hidden" name="_csrf" value={csrfToken} />
              <input type="hidden" name="jobId" value={j.id} />
              <Button type="submit" size="sm" variant="ghost" class="text-red-600">
                Revert this job
              </Button>
            </form>
          {/if}
        </div>
      {/each}
    </CardContent>
  </Card>
</div>
