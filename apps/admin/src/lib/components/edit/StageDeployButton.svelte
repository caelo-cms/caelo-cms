<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * v0.8.0 — split-button Stage / Publish in the /edit toolbar.
   *
   * v0.7.x put this in the chat overlay (per-chat surface). v0.8.0 moves
   * it to the toolbar so the gesture lives in page-mental-model context
   * — chats stay the atomic revert unit under the hood, but the
   * operator never has to think about them to ship work.
   *
   * Three gestures:
   *
   *   [Stage to staging (N)]  → merges everything in the active chat's
   *                             branch into main (without closing the
   *                             chat), then runs a full staging deploy.
   *                             The staging URL is a 1:1 preview of
   *                             what production would see.
   *   [▾] (dropdown)          → opens the Promote-to-production modal
   *                             with per-kind checkboxes. Mentions the
   *                             current staging build at the top so the
   *                             operator knows what they're promoting.
   *   Click the (N) badge     → opens a small popover listing the
   *                             pages + entities the chat has touched.
   *                             Preview of the Stage blast radius
   *                             without triggering it.
   */
  import { enhance } from "$app/forms";
  import { Button } from "$lib/components/ui/button";
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog";
  import { ChevronDown } from "lucide-svelte";

  interface PendingEntity {
    kind: string;
    entityId: string;
    label: string;
    detail?: string;
  }
  interface PendingChangesView {
    pending: { pages: PendingEntity[]; globals: PendingEntity[]; lists: PendingEntity[] };
    staged: { pages: PendingEntity[]; globals: PendingEntity[]; lists: PendingEntity[] };
  }
  interface LastStaged {
    runId: string;
    finishedAt: string;
    previewUrl: string | null;
  }

  let {
    pendingChanges,
    branchChangeCount = 0,
    csrfToken,
    chatSessionId,
    activePageId = null,
    sessionPublished = false,
    lastStaged = null,
  }: {
    pendingChanges: PendingChangesView;
    /**
     * v0.7.3 — authoritative branch-snapshot count (chat.branch_change_count).
     * Drives the split-button visibility + badge. Independent from
     * pendingChanges (which drops entities with 'published' marks from
     * prior chat.publish runs).
     */
    branchChangeCount?: number;
    csrfToken: string;
    chatSessionId: string;
    activePageId?: string | null;
    sessionPublished?: boolean;
    /**
     * v0.8.0 — last successful staging deploy. Shown atop the Promote
     * modal so the operator knows what they're about to push live.
     */
    lastStaged?: LastStaged | null;
  } = $props();

  /**
   * Per-kind change counts for the dropdown checkboxes. "Pages" lumps
   * direct page edits + per-page layout + per-placement content into
   * one bucket because the operator's mental model is "the page"; the
   * server-side impact resolver categorizes finer. "Modules" /
   * "Templates" / "Lists" / "Layout chrome" map 1:1 to entity kinds in
   * the snapshot tables (layout chrome is the v0.8.0 addition for
   * `layout_modules.set` snapshots that used to be invisible).
   */
  function countByKind(group: "pages" | "globals" | "lists", kinds: ReadonlyArray<string>): number {
    const buckets: PendingEntity[][] = [
      pendingChanges.pending[group],
      pendingChanges.staged[group],
    ];
    let n = 0;
    for (const arr of buckets) {
      for (const e of arr) if (kinds.includes(e.kind)) n += 1;
    }
    return n;
  }
  const pagesCount = $derived(countByKind("pages", ["page", "pageLayout", "pageModuleContent"]));
  const modulesCount = $derived(countByKind("globals", ["module"]));
  const templatesCount = $derived(countByKind("globals", ["template"]));
  const layoutChromeCount = $derived(countByKind("globals", ["layout"]));
  const listsCount = $derived(countByKind("lists", ["structuredSet"]));

  let dialogOpen = $state(false);
  let popoverOpen = $state(false);
  let popoverRef = $state<HTMLDivElement | null>(null);
  let pillRef = $state<HTMLButtonElement | null>(null);
  let publishing = $state(false);
  let staging = $state(false);

  // v0.8.1 — popover dismissal. The pre-v0.8.1 popover stayed open
  // until the operator clicked the pill again; missing Esc + click-
  // outside handlers was an a11y issue and a UX surprise (opening
  // the Promote modal left the popover hanging). Attached via
  // $effect so listeners cleanly mount/unmount with the open state.
  $effect(() => {
    if (!popoverOpen) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") popoverOpen = false;
    }
    function onClick(e: MouseEvent): void {
      const t = e.target as Node | null;
      if (!t) return;
      if (popoverRef?.contains(t) || pillRef?.contains(t)) return;
      popoverOpen = false;
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  });
  let userPagesChoice = $state(true);
  let userModulesChoice = $state(true);
  let userTemplatesChoice = $state(true);
  let userListsChoice = $state(true);
  let userLayoutChromeChoice = $state(true);
  /**
   * Effective checkbox state. When a kind has zero changes, force it
   * off + non-submittable regardless of the user's last toggle.
   */
  const effectivePages = $derived(pagesCount > 0 && userPagesChoice);
  const effectiveModules = $derived(modulesCount > 0 && userModulesChoice);
  const effectiveTemplates = $derived(templatesCount > 0 && userTemplatesChoice);
  const effectiveLists = $derived(listsCount > 0 && userListsChoice);
  const effectiveLayoutChrome = $derived(layoutChromeCount > 0 && userLayoutChromeChoice);

  function formatRelativeTime(iso: string): string {
    const t = new Date(iso).getTime();
    const dt = Math.max(0, Date.now() - t);
    if (dt < 60_000) return "just now";
    if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
    if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
    return `${Math.floor(dt / 86_400_000)}d ago`;
  }
</script>

{#if sessionPublished}
  <span class="text-xs text-muted-foreground italic">Chat published</span>
{:else if branchChangeCount === 0 && !lastStaged}
  <span class="text-xs text-muted-foreground">No pending changes</span>
{:else if branchChangeCount === 0}
  <!-- v0.8.1 — chat has no fresh pending edits but staging holds
       a build the operator hasn't promoted yet. Show only the
       Promote dropdown so the operator can finish the loop. The
       Stage half is omitted (nothing to stage) but the ▾ stays
       reachable. Reuses the same Promote modal. -->
  <div class="inline-flex items-center" data-testid="stage-deploy">
    <Button
      type="button"
      size="sm"
      onclick={() => {
        dialogOpen = true;
      }}
      data-testid="promote-only-btn"
      title="Promote the current staging build to production"
    >
      Promote staging
      <ChevronDown class="ml-1 size-3" />
    </Button>
  </div>
{:else}
  <div class="relative inline-flex items-center gap-1" data-testid="stage-deploy">
    <!-- (N) badge: clickable popover with blast-radius preview. -->
    <button
      bind:this={pillRef}
      type="button"
      class="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-500/40 hover:bg-amber-500/25 dark:text-amber-300"
      onclick={() => {
        popoverOpen = !popoverOpen;
      }}
      aria-expanded={popoverOpen}
      data-testid="pending-pill"
      title="Preview what Stage will ship"
    >
      {branchChangeCount} pending
    </button>

    {#if popoverOpen}
      <div
        bind:this={popoverRef}
        class="absolute right-0 top-full z-40 mt-1 w-72 rounded-md border bg-background p-3 shadow-lg"
        role="dialog"
        aria-label="Pending-changes preview"
      >
        <h4 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Will be staged ({branchChangeCount})
        </h4>
        <ul class="space-y-1 text-xs">
          {#each pendingChanges.pending.pages as e (e.entityId)}
            <li class="flex items-center gap-2">
              <span class="rounded bg-blue-500/10 px-1 py-0.5 font-mono text-[10px] text-blue-700"
                >page</span
              >
              <span class="truncate">{e.label}</span>
            </li>
          {/each}
          {#each pendingChanges.pending.globals as e (e.entityId)}
            <li class="flex items-center gap-2">
              <span
                class="rounded bg-purple-500/10 px-1 py-0.5 font-mono text-[10px] text-purple-700"
                >{e.kind}</span
              >
              <span class="truncate">{e.label}</span>
              {#if e.detail}<span class="text-muted-foreground truncate">— {e.detail}</span>{/if}
            </li>
          {/each}
          {#each pendingChanges.pending.lists as e (e.entityId)}
            <li class="flex items-center gap-2">
              <span class="rounded bg-emerald-500/10 px-1 py-0.5 font-mono text-[10px] text-emerald-700"
                >list</span
              >
              <span class="truncate">{e.label}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <form
      method="post"
      action="?/stageAndDeployStaging"
      use:enhance={() => {
        staging = true;
        return async ({ update }) => {
          try {
            await update({ reset: false });
          } finally {
            staging = false;
          }
        };
      }}
      class="contents"
    >
      <input type="hidden" name="_csrf" value={csrfToken} />
      <input type="hidden" name="chatSessionId" value={chatSessionId} />
      {#if activePageId}
        <input type="hidden" name="pageId" value={activePageId} />
      {/if}
      <Button
        type="submit"
        size="sm"
        disabled={staging || publishing}
        class="rounded-r-none border-r-0"
        title="Merge chat branch to main + rebuild staging"
        data-testid="stage-btn"
      >
        {staging ? "Staging…" : "Stage to staging"}
      </Button>
    </form>
    <Button
      type="button"
      size="sm"
      disabled={staging || publishing}
      class="rounded-l-none px-2"
      aria-label="Open production publish options"
      data-testid="publish-dropdown-btn"
      onclick={() => {
        // Close the preview popover when entering the Promote modal —
        // both being open at once is visually noisy and the popover
        // wouldn't dismiss on the modal's backdrop click (different
        // event-target tree).
        popoverOpen = false;
        dialogOpen = true;
      }}
    >
      <ChevronDown class="size-3" />
    </Button>
  </div>
{/if}

<Dialog bind:open={dialogOpen}>
  <DialogContent class="sm:max-w-md">
    <DialogHeader>
      <DialogTitle>Promote staging to production</DialogTitle>
      <DialogDescription>
        Stage runs the staging build. This step promotes what's currently on staging to your live
        site. Unchecked kinds keep their current production HTML; checked kinds re-bake every page
        they touch.
      </DialogDescription>
    </DialogHeader>

    {#if lastStaged}
      <div
        class="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
        data-testid="last-staged-banner"
      >
        Last staged {formatRelativeTime(lastStaged.finishedAt)}
        {#if lastStaged.previewUrl}
          — <a
            href={lastStaged.previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="underline">preview</a
          >
        {/if}
      </div>
    {:else}
      <div class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
        No successful staging build yet. Click "Stage to staging" first so this Promote ships
        something other than the previous production build.
      </div>
    {/if}

    <form
      method="post"
      action="?/publishToProduction"
      use:enhance={() => {
        publishing = true;
        return async ({ result, update }) => {
          try {
            await update({ reset: false });
          } finally {
            publishing = false;
          }
          if (result.type === "success") {
            dialogOpen = false;
          }
        };
      }}
      data-testid="publish-form"
    >
      <input type="hidden" name="_csrf" value={csrfToken} />
      <input type="hidden" name="chatSessionId" value={chatSessionId} />

      <ul class="space-y-2 py-2">
        <li>
          <label class="flex items-center gap-2 text-sm" class:opacity-50={pagesCount === 0}>
            <input
              type="checkbox"
              name="kind"
              value="pages"
              class="h-4 w-4 rounded border-input"
              checked={effectivePages}
              disabled={pagesCount === 0}
              onchange={(e) => {
                userPagesChoice = (e.currentTarget as HTMLInputElement).checked;
              }}
            />
            <span class="font-medium">Pages</span>
            <span class="text-xs text-muted-foreground">({pagesCount} changed)</span>
          </label>
        </li>
        <li>
          <label class="flex items-center gap-2 text-sm" class:opacity-50={modulesCount === 0}>
            <input
              type="checkbox"
              name="kind"
              value="modules"
              class="h-4 w-4 rounded border-input"
              checked={effectiveModules}
              disabled={modulesCount === 0}
              onchange={(e) => {
                userModulesChoice = (e.currentTarget as HTMLInputElement).checked;
              }}
            />
            <span class="font-medium">Modules</span>
            <span class="text-xs text-muted-foreground">({modulesCount} changed)</span>
          </label>
        </li>
        <li>
          <label class="flex items-center gap-2 text-sm" class:opacity-50={templatesCount === 0}>
            <input
              type="checkbox"
              name="kind"
              value="templates"
              class="h-4 w-4 rounded border-input"
              checked={effectiveTemplates}
              disabled={templatesCount === 0}
              onchange={(e) => {
                userTemplatesChoice = (e.currentTarget as HTMLInputElement).checked;
              }}
            />
            <span class="font-medium">Templates</span>
            <span class="text-xs text-muted-foreground">({templatesCount} changed)</span>
          </label>
        </li>
        <li>
          <label class="flex items-center gap-2 text-sm" class:opacity-50={layoutChromeCount === 0}>
            <input
              type="checkbox"
              name="kind"
              value="layoutChrome"
              class="h-4 w-4 rounded border-input"
              checked={effectiveLayoutChrome}
              disabled={layoutChromeCount === 0}
              onchange={(e) => {
                userLayoutChromeChoice = (e.currentTarget as HTMLInputElement).checked;
              }}
            />
            <span class="font-medium">Layout chrome</span>
            <span class="text-xs text-muted-foreground">
              ({layoutChromeCount} changed — triggers full rebuild)
            </span>
          </label>
        </li>
        <li>
          <label class="flex items-center gap-2 text-sm" class:opacity-50={listsCount === 0}>
            <input
              type="checkbox"
              name="kind"
              value="lists"
              class="h-4 w-4 rounded border-input"
              checked={effectiveLists}
              disabled={listsCount === 0}
              onchange={(e) => {
                userListsChoice = (e.currentTarget as HTMLInputElement).checked;
              }}
            />
            <span class="font-medium">Lists</span>
            <span class="text-xs text-muted-foreground">
              ({listsCount} changed — triggers full rebuild)
            </span>
          </label>
        </li>
      </ul>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onclick={() => {
            dialogOpen = false;
          }}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={publishing}
          data-testid="publish-submit-btn"
        >
          {publishing ? "Publishing…" : "Promote to production"}
        </Button>
      </DialogFooter>
    </form>
  </DialogContent>
</Dialog>
