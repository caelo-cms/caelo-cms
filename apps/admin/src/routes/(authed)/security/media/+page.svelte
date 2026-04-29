<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P7 — Owner-only media panel. CDN-copy toggle + threshold +
   * library stats.
   *
   * Self-hosted: P7 emits `cdn_manifest.json` from the static
   * generator listing assets above the threshold. The actual copy +
   * URL rewrite to a CDN domain is the P15 cloud adapter's job.
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

  let enabled = $state(data.cdn.enabled);
  let threshold = $state(data.cdn.threshold);
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Media settings</h1>
    <p class="text-sm text-muted-foreground">CDN copy + library stats. Owner-only.</p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok && form?.message}
    <Alert><AlertDescription>{form.message}</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">CDN copy</CardTitle>
      <CardDescription>
        When enabled, the static generator emits a manifest of assets used at least N times so a
        cloud adapter (P15) can copy them to a CDN. Self-hosted installs see only the manifest.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/setCdn" class="space-y-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <input type="hidden" name="enabled" value={String(enabled)} />
        <div class="flex items-center gap-2">
          <input
            type="checkbox"
            id="enabled-input"
            checked={enabled}
            onchange={(e) => (enabled = (e.currentTarget as HTMLInputElement).checked)}
          />
          <Label for="enabled-input">Emit CDN manifest at deploy</Label>
        </div>
        <div class="space-y-2">
          <Label for="threshold">Usage threshold (≥ N)</Label>
          <Input
            id="threshold"
            name="threshold"
            type="number"
            min={1}
            max={10000}
            value={threshold}
            oninput={(e) => (threshold = Number((e.currentTarget as HTMLInputElement).value))}
          />
        </div>
        <Button type="submit">Save</Button>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Library stats</CardTitle>
    </CardHeader>
    <CardContent class="space-y-2 text-sm">
      <p>
        <span class="font-medium">{data.totalAssets}</span> total asset{data.totalAssets === 1
          ? ""
          : "s"}.
      </p>
      <p class="text-muted-foreground">
        Bytes for the 10 most-used assets: {(data.visibleBytes / (1024 * 1024)).toFixed(1)} MB
      </p>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Top 10 most used</CardTitle>
    </CardHeader>
    <CardContent>
      {#if data.topAssets.length === 0}
        <p class="text-sm text-muted-foreground">No usage tracked yet.</p>
      {:else}
        <ul class="space-y-1 text-sm">
          {#each data.topAssets as a (a.id)}
            <li>
              <a class="font-medium underline-offset-4 hover:underline" href={`/content/media/${a.id}`}>
                {a.originalName}
              </a>
              <span class="text-muted-foreground"> — used {a.usageCount}×</span>
            </li>
          {/each}
        </ul>
      {/if}
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Alt-text proposals</CardTitle>
      <CardDescription>
        AI-suggested alt text from the alt scanner. Reviewed proposals are stamped with your
        actor + timestamp; rejected ones stay for audit.
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.altProposals.length === 0}
        <p class="text-sm text-muted-foreground">
          No pending proposals. Run <code class="font-mono">bun run apps/admin/scripts/scan-media-alt.ts</code>
          to generate suggestions for assets with missing alt text.
        </p>
      {:else}
        <ul class="space-y-3 text-sm">
          {#each data.altProposals as p (p.id)}
            <li class="rounded-md border border-border p-3">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1 space-y-1">
                  <p class="truncate font-medium">
                    <a class="underline-offset-4 hover:underline" href={`/content/media/${p.assetId}`}>
                      {p.assetName}
                    </a>
                  </p>
                  {#if p.currentAlt}
                    <p class="text-xs text-muted-foreground">Current: {p.currentAlt}</p>
                  {:else}
                    <p class="text-xs italic text-muted-foreground">Current: (no alt)</p>
                  {/if}
                  <p class="font-medium">Proposed: <span class="font-normal">{p.proposedAlt}</span></p>
                  {#if p.rationale}
                    <p class="text-xs text-muted-foreground">{p.rationale}</p>
                  {/if}
                </div>
                <div class="flex shrink-0 gap-2">
                  <form method="post" action="?/reviewAlt">
                    <input type="hidden" name="_csrf" value={data.csrfToken} />
                    <input type="hidden" name="proposalId" value={p.id} />
                    <input type="hidden" name="accept" value="true" />
                    <Button type="submit" size="sm">Accept</Button>
                  </form>
                  <form method="post" action="?/reviewAlt">
                    <input type="hidden" name="_csrf" value={data.csrfToken} />
                    <input type="hidden" name="proposalId" value={p.id} />
                    <input type="hidden" name="accept" value="false" />
                    <Button type="submit" size="sm" variant="outline">Reject</Button>
                  </form>
                </div>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </CardContent>
  </Card>
</div>
