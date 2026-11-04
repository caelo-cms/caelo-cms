<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * #1420 — the stopped plugins as a card, on the screens where the Owner
   * looks for what happened: the dashboard and Settings → Updates.
   */

  import { Button } from "#lib/components/ui/button/index.js";
  import { Card, CardDescription, CardHeader, CardTitle } from "#lib/components/ui/card/index.js";
  import { pluginApprovals } from "#lib/plugin-approvals.svelte.js";

  let { testid }: { testid: string } = $props();

  const releases = $derived(pluginApprovals.releases);
  const reviews = $derived(pluginApprovals.reviews);
</script>

{#if releases.length + reviews.length > 0}
  <Card class="border-amber-300 dark:border-amber-700" data-testid={testid}>
    <CardHeader class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="space-y-1.5">
        <CardTitle class="text-base">
          {releases.length > 0 ? "Plugins are stopped until approved" : "Plugins wait for your review"}
        </CardTitle>
        <CardDescription>
          {#if releases.length > 0}
            A new version needs {pluginApprovals.canApprove ? "your" : "an Owner's"} approval, and
            Publish live is blocked until then.
          {/if}
        </CardDescription>
        <ul class="text-sm">
          {#each releases as release (release.slug)}
            <li>
              <span class="font-medium">{release.slug}</span>
              {#if release.capabilities.length > 0}
                : new permissions {release.capabilities.map((c) => c.label).join(", ")}
              {/if}
            </li>
          {/each}
          {#each reviews as review (review.slug)}
            <li><span class="font-medium">{review.slug}</span>: package to review</li>
          {/each}
        </ul>
      </div>
      {#if pluginApprovals.canApprove}
        <Button data-testid="{testid}-review" onclick={() => (pluginApprovals.dialogOpen = true)}>
          Review
        </Button>
      {/if}
    </CardHeader>
  </Card>
{/if}
