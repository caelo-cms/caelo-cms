<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P6.6b — bell icon in the AppShell topbar showing aggregate
   * counts from `notifications.aggregate`. Polls every 30s while the
   * tab is visible (paused via the Page Visibility API to avoid
   * burning DB calls in background tabs). Click opens a dropdown
   * with per-source rows + click-through links.
   */

  import { Bell } from "lucide-svelte";
  import { onDestroy, onMount } from "svelte";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Card, CardContent } from "#lib/components/ui/card/index.js";
  import { Skeleton } from "#lib/components/ui/skeleton/index.js";

  interface Counts {
    pendingProposals: number;
    failedDeploys: number;
    staleBranches: number;
    upgradeAvailable: boolean;
    latestVersion: string | null;
    releaseUrl: string | null;
    /** #696 — where the Owner installs the update (Settings → Updates). */
    updatesPath: string;
    /** Epic #901 — the Owner has not yet decided whether detected bugs go to the Caelo team. */
    bugForwardingUndecided: boolean;
    total: number;
  }

  let counts = $state<Counts>({
    pendingProposals: 0,
    failedDeploys: 0,
    staleBranches: 0,
    upgradeAvailable: false,
    latestVersion: null,
    releaseUrl: null,
    updatesPath: "/settings/updates",
    bugForwardingUndecided: false,
    total: 0,
  });
  let loaded = $state(false);
  let open = $state(false);
  let pollHandle: ReturnType<typeof setInterval> | null = null;
  let dropdownEl: HTMLDivElement | null = $state(null);

  async function fetchCounts() {
    try {
      const r = await fetch("/api/notifications", {
        method: "GET",
        headers: { accept: "application/json" },
      });
      if (!r.ok) return;
      const json = (await r.json()) as Counts;
      counts = json;
      loaded = true;
    } catch {
      // Network failure is non-fatal — leave the last-known counts
      // visible until the next successful poll.
    }
  }

  function startPolling() {
    if (pollHandle) return;
    void fetchCounts();
    pollHandle = setInterval(() => {
      if (document.visibilityState === "visible") void fetchCounts();
    }, 30_000);
  }
  function stopPolling() {
    if (pollHandle) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  }

  function onDocClick(e: MouseEvent) {
    if (!open || !dropdownEl) return;
    if (!dropdownEl.contains(e.target as Node)) open = false;
  }

  onMount(() => {
    startPolling();
    document.addEventListener("click", onDocClick);
  });
  onDestroy(() => {
    stopPolling();
    if (typeof document !== "undefined") {
      document.removeEventListener("click", onDocClick);
    }
  });
</script>

<div class="relative" bind:this={dropdownEl}>
  <!-- The accessible name is built from the button's content, not an
       aria-label: the badge shows the count, and a label that does not
       contain the visible text fails WCAG 2.5.3 (axe
       label-content-name-mismatch). Name: "Notifications, 3 pending". -->
  <Button
    variant="ghost"
    size="icon"
    aria-expanded={open}
    onclick={(e) => {
      e.stopPropagation();
      open = !open;
    }}
  >
    <Bell class="size-4" aria-hidden="true" />
    <span class="sr-only">Notifications{counts.total > 0 ? ", " : ""}</span>
    {#if counts.total > 0}
      <span
        class="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium leading-none text-destructive-foreground"
        >{counts.total > 9 ? "9+" : counts.total}<span class="sr-only"> pending</span></span
      >
    {/if}
  </Button>
  <!-- P6.6 polish — aria-live region announces count changes to
       screen readers. Polite + atomic so the full message reads once
       when `total` transitions; visually hidden via sr-only. -->
  <span class="sr-only" aria-live="polite" aria-atomic="true">
    {#if loaded && counts.total > 0}
      {counts.total} pending notification{counts.total === 1 ? "" : "s"}
    {/if}
  </span>

  {#if open}
    <div class="absolute right-0 z-40 mt-2 w-80">
      <Card>
        <CardContent class="space-y-2 p-3 text-sm">
          {#if !loaded}
            <!-- P6.6 closing pass — Skeleton placeholder while the
                 first fetch hasn't completed yet (fast path: ~50ms,
                 visible on slow connections / cold-cache mounts). -->
            <div class="space-y-2 py-1">
              <Skeleton class="h-4 w-2/3" />
              <Skeleton class="h-4 w-1/2" />
            </div>
          {:else if counts.total === 0}
            <p class="py-2 text-center text-sm text-muted-foreground">
              No pending notifications.
            </p>
          {:else}
            {#if counts.pendingProposals > 0}
              <a
                href="/settings/pending"
                class="-mx-1 flex items-center gap-2 rounded-md px-2 py-2 hover:bg-accent"
                onclick={() => (open = false)}
              >
                <Badge variant="secondary">{counts.pendingProposals}</Badge>
                <span>AI proposals awaiting your review</span>
              </a>
            {/if}
            {#if counts.failedDeploys > 0}
              <a
                href="/settings/deployments"
                class="-mx-1 flex items-center gap-2 rounded-md px-2 py-2 hover:bg-accent"
                onclick={() => (open = false)}
              >
                <Badge variant="destructive">{counts.failedDeploys}</Badge>
                <span>Latest deploy failed and not yet fixed</span>
              </a>
            {/if}
            {#if counts.staleBranches > 0}
              <a
                href="/content/chat"
                class="-mx-1 flex items-center gap-2 rounded-md px-2 py-2 hover:bg-accent"
                onclick={() => (open = false)}
              >
                <Badge variant="outline">{counts.staleBranches}</Badge>
                <span>Chats inactive for 14+ days</span>
              </a>
            {/if}
            {#if counts.bugForwardingUndecided}
              <a
                href="/settings/bugs"
                class="-mx-1 flex items-center gap-2 rounded-md px-2 py-2 hover:bg-accent"
                data-testid="bug-forwarding-notice"
                onclick={() => (open = false)}
              >
                <Badge variant="outline">?</Badge>
                <span>Send detected bugs to the Caelo team?</span>
              </a>
            {/if}
            {#if counts.upgradeAvailable && counts.latestVersion}
              <!-- #696 — the notice opens Settings → Updates (versions,
                   notes and the install command); the release notes stay
                   one click away beside it. -->
              <div class="-mx-1 flex items-center gap-1 rounded-md hover:bg-accent">
                <a
                  href={counts.updatesPath}
                  class="flex min-w-0 flex-1 items-center gap-2 px-2 py-2"
                  data-testid="release-notice"
                  onclick={() => (open = false)}
                >
                  <Badge>v{counts.latestVersion}</Badge>
                  <span>New Caelo release available</span>
                </a>
                {#if counts.releaseUrl}
                  <a
                    href={counts.releaseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="shrink-0 px-2 py-2 text-xs text-muted-foreground underline underline-offset-4"
                    onclick={() => (open = false)}
                  >
                    Notes
                  </a>
                {/if}
              </div>
            {/if}
          {/if}
        </CardContent>
      </Card>
    </div>
  {/if}
</div>
