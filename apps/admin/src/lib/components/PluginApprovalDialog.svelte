<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * #1420 — the one place a plugin release is approved, opened from wherever
   * the Owner stands. Each new permission reads as what it allows
   * (CMS_REQUIREMENTS §14.5), and the approval is bound to the digest shown.
   */

  import { toast } from "svelte-sonner";
  import { Button } from "#lib/components/ui/button/index.js";
  import { buttonVariants } from "#lib/components/ui/button/button-variants.js";
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
  } from "#lib/components/ui/dialog/index.js";
  import { pluginApprovals, type ReleaseApproval } from "#lib/plugin-approvals.svelte.js";

  let { csrfToken }: { csrfToken: string } = $props();

  let approving = $state<string | null>(null);
  let failure = $state<string | null>(null);

  async function approve(release: ReleaseApproval) {
    approving = release.slug;
    failure = null;
    try {
      toast.success(await pluginApprovals.approve(release, csrfToken));
    } catch (e) {
      failure = e instanceof Error ? e.message : "Approving failed.";
      // A release replaced meanwhile must show its own contents, not stay stale.
      await pluginApprovals.refresh();
    } finally {
      approving = null;
    }
  }
</script>

<Dialog bind:open={pluginApprovals.dialogOpen}>
  <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-xl" data-testid="plugin-approval-dialog">
    <DialogHeader>
      <DialogTitle>Plugins waiting for you</DialogTitle>
      <DialogDescription>
        A plugin's new version stays stopped until you approve what it asks for. Its data is kept.
      </DialogDescription>
    </DialogHeader>

    {#if failure}
      <p class="text-sm text-red-700 dark:text-red-400" role="alert" data-testid="plugin-approval-error">
        {failure}
      </p>
    {/if}

    <div class="space-y-5 text-sm">
      {#each pluginApprovals.releases as release (release.slug)}
        <section class="space-y-2" data-testid="plugin-approval-{release.slug}">
          <h3 class="font-medium">{release.slug} <span class="text-muted-foreground">{release.version}</span></h3>

          {#if release.capabilities.length > 0}
            <div>
              <p class="text-xs font-medium text-muted-foreground">New permissions</p>
              <ul class="mt-1 space-y-1">
                {#each release.capabilities as capability (capability.id)}
                  <li>
                    <span class="font-medium">{capability.label}:</span>
                    {capability.allows}
                    {#if capability.authorReason}
                      <span class="block text-xs text-muted-foreground">
                        The plugin's author says: {capability.authorReason}
                      </span>
                    {/if}
                  </li>
                {/each}
              </ul>
            </div>
          {/if}

          {#if release.changes === null}
            <p class="text-xs text-muted-foreground" data-testid="plugin-approval-unknown-{release.slug}">
              What else changed is unknown: Caelo did not record the version you approved before.
            </p>
          {:else if release.changes.length > 0}
            <div data-testid="plugin-approval-changes-{release.slug}">
              <p class="text-xs font-medium text-muted-foreground">What changed</p>
              <ul class="mt-1 space-y-1">
                {#each release.changes as change (change.area)}
                  <li>
                    <span class="font-medium">{change.area}:</span>
                    {[
                      change.added.length > 0 ? `added ${change.added.join(", ")}` : null,
                      change.removed.length > 0 ? `removed ${change.removed.join(", ")}` : null,
                      change.changed.length > 0 ? `changed ${change.changed.join(", ")}` : null,
                    ]
                      .filter((part) => part !== null)
                      .join("; ")}
                  </li>
                {/each}
              </ul>
            </div>
          {:else if release.capabilities.length === 0}
            <p class="text-xs text-muted-foreground">Only the version number changed.</p>
          {/if}

          {#if pluginApprovals.canApprove}
            <Button
              size="sm"
              disabled={approving !== null}
              data-testid="approve-capabilities-{release.slug}"
              onclick={() => approve(release)}
            >
              {approving === release.slug ? "Approving…" : "Approve this release"}
            </Button>
          {:else}
            <p class="text-xs text-muted-foreground">An Owner needs to approve this release.</p>
          {/if}
        </section>
      {/each}

      {#if pluginApprovals.reviews.length > 0}
        <section class="space-y-2" data-testid="plugin-approval-reviews">
          <h3 class="font-medium">Packages to review</h3>
          <ul class="space-y-1">
            {#each pluginApprovals.reviews as review (review.slug)}
              <li>
                {review.slug} {review.version}
                <span class="text-muted-foreground">
                  {review.isUpdate ? "(update of a running plugin)" : "(new plugin)"}
                </span>
              </li>
            {/each}
          </ul>
          <a
            class={buttonVariants({ size: "sm", variant: "outline" })}
            href="/settings/plugins/installations"
            onclick={() => (pluginApprovals.dialogOpen = false)}
          >
            Open the review
          </a>
        </section>
      {/if}
    </div>
  </DialogContent>
</Dialog>
