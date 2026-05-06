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
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Card, CardContent } from "$lib/components/ui/card/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";

  interface Counts {
    pendingProposals: number;
    failedDeploys: number;
    staleBranches: number;
    upgradeAvailable: boolean;
    latestVersion: string | null;
    releaseUrl: string | null;
    total: number;
  }

  let counts = $state<Counts>({
    pendingProposals: 0,
    failedDeploys: 0,
    staleBranches: 0,
    upgradeAvailable: false,
    latestVersion: null,
    releaseUrl: null,
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
  <Button
    variant="ghost"
    size="icon"
    aria-label={counts.total > 0
      ? `Notifications (${counts.total} pending)`
      : "Notifications"}
    aria-expanded={open}
    onclick={(e) => {
      e.stopPropagation();
      open = !open;
    }}
  >
    <Bell class="size-4" />
    {#if counts.total > 0}
      <span
        class="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium leading-none text-destructive-foreground"
        aria-hidden="true">{counts.total > 9 ? "9+" : counts.total}</span>
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
                href="/security/ai/memory-proposals"
                class="-mx-1 flex items-center gap-2 rounded-md px-2 py-2 hover:bg-accent"
                onclick={() => (open = false)}
              >
                <Badge variant="secondary">{counts.pendingProposals}</Badge>
                <span>AI memory proposals awaiting review</span>
              </a>
            {/if}
            {#if counts.failedDeploys > 0}
              <a
                href="/security/deployments"
                class="-mx-1 flex items-center gap-2 rounded-md px-2 py-2 hover:bg-accent"
                onclick={() => (open = false)}
              >
                <Badge variant="destructive">{counts.failedDeploys}</Badge>
                <span>Failed deploys in the last 7 days</span>
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
            {#if counts.upgradeAvailable && counts.latestVersion}
              <a
                href={counts.releaseUrl ?? "https://github.com/caelo-cms/caelo-cms/releases"}
                target="_blank"
                rel="noopener noreferrer"
                class="-mx-1 flex items-center gap-2 rounded-md px-2 py-2 hover:bg-accent"
                onclick={() => (open = false)}
              >
                <Badge>v{counts.latestVersion}</Badge>
                <span>New Caelo release available — release notes →</span>
              </a>
            {/if}
          {/if}
        </CardContent>
      </Card>
    </div>
  {/if}
</div>
