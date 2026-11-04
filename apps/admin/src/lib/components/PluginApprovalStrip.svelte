<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * #1420 — the line above every admin screen while a plugin waits for a
   * decision. It cannot be dismissed: a stopped plugin blocks Publish live
   * until someone decides.
   */

  import { Button } from "#lib/components/ui/button/index.js";
  import { pluginApprovals } from "#lib/plugin-approvals.svelte.js";
  import { cn } from "#lib/utils.js";

  /** `bar`: flush, for the editor's banner area. `card`: inside a page's content. */
  let { variant = "card" }: { variant?: "bar" | "card" } = $props();

  const releases = $derived(pluginApprovals.releases);
  const reviews = $derived(pluginApprovals.reviews);
  const count = $derived(releases.length);
  const names = $derived(releases.map((r) => r.slug).join(", "));
</script>

{#if count + reviews.length > 0}
  <div
    role="region"
    aria-label="Plugins waiting for a decision"
    data-testid="plugin-approval-strip"
    class={cn(
      "flex flex-wrap items-center gap-x-3 gap-y-1 border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200",
      variant === "bar" ? "min-h-9 border-b px-3 py-1 text-xs" : "mb-6 rounded border p-3 text-sm",
    )}
  >
    <p class="min-w-0 flex-1">
      {#if count > 0}
        <span class="font-medium">
          {count === 1 ? "1 plugin is" : `${count} plugins are`} stopped: {names}.
        </span>
        {pluginApprovals.canApprove
          ? "A new version needs your approval. Publish live is blocked until then."
          : "A new version needs an Owner's approval. Publish live is blocked until then."}
        {#if reviews.length > 0}
          {reviews.length === 1
            ? "1 plugin package also waits for your review."
            : `${reviews.length} plugin packages also wait for your review.`}
        {/if}
      {:else}
        <span class="font-medium">
          {reviews.length === 1
            ? "1 plugin package waits"
            : `${reviews.length} plugin packages wait`} for your review.
        </span>
      {/if}
    </p>
    {#if pluginApprovals.canApprove}
      <Button
        size="sm"
        data-testid="plugin-approval-review"
        onclick={() => (pluginApprovals.dialogOpen = true)}
      >
        Review
      </Button>
    {/if}
  </div>
{/if}
