<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * v0.7.0 — split-button Stage / Publish for the /edit overlay.
   *
   * Caelo's only Stage/Publish surface (v0.7.1 dropped the legacy
   * sidebar picker in /content/chat — the formal chat.publish op
   * stays available programmatically, but operators do all Stage +
   * Publish work through this component now).
   *
   * Two clicks cover the loop the operator actually cares about:
   *
   *   [Stage to staging]  → merges everything in the chat branch into
   *                         main (without closing the chat), then runs
   *                         a full staging deploy. The staging URL is
   *                         a 1:1 preview of what production would see.
   *   [▾] (dropdown)      → opens a dialog with per-kind checkboxes
   *                         (Pages / Modules / Templates / Lists) and
   *                         a "Publish to production" button. The form
   *                         action computes a precise changedPageIds
   *                         set from the checked kinds so the
   *                         production bake re-renders only the
   *                         affected routes.
   *
   * The chat stays editable across Stage clicks — `chat.merge_to_main`
   * never sets `published_at` and never releases the chat's locks.
   * Production Publish does NOT call `chat.publish` either (the chat
   * is the workspace, not the publish boundary in /edit).
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

  let {
    pendingChanges,
    csrfToken,
    chatSessionId,
    activePageId = null,
    sessionPublished = false,
  }: {
    pendingChanges: PendingChangesView;
    csrfToken: string;
    chatSessionId: string;
    activePageId?: string | null;
    sessionPublished?: boolean;
  } = $props();

  const pendingCount = $derived(
    pendingChanges.pending.pages.length +
      pendingChanges.pending.globals.length +
      pendingChanges.pending.lists.length +
      pendingChanges.staged.pages.length +
      pendingChanges.staged.globals.length +
      pendingChanges.staged.lists.length,
  );

  /**
   * Per-kind change counts for the dropdown checkboxes. "Pages" lumps
   * direct page edits + per-page layout + per-placement content into
   * one bucket because the operator's mental model is "the page"; the
   * server-side impact resolver categorizes finer. "Modules" /
   * "Templates" / "Lists" map 1:1 to entity kinds in the snapshot
   * tables.
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
  const listsCount = $derived(countByKind("lists", ["structuredSet"]));

  let dialogOpen = $state(false);
  let publishing = $state(false);
  let staging = $state(false);
  let userPagesChoice = $state(true);
  let userModulesChoice = $state(true);
  let userTemplatesChoice = $state(true);
  let userListsChoice = $state(true);
  /**
   * Effective checkbox state. When a kind has zero changes, force it
   * off + non-submittable regardless of the user's last toggle.
   * Avoids the earlier UX wart where a disabled-but-checked box would
   * still send `kind=pages` on submit, causing the server-side impact
   * resolver to no-op silently on the operator's behalf — the operator
   * couldn't tell why their "I unchecked Pages" intent wasn't being
   * honored.
   */
  const effectivePages = $derived(pagesCount > 0 && userPagesChoice);
  const effectiveModules = $derived(modulesCount > 0 && userModulesChoice);
  const effectiveTemplates = $derived(templatesCount > 0 && userTemplatesChoice);
  const effectiveLists = $derived(listsCount > 0 && userListsChoice);
</script>

{#if sessionPublished}
  <span class="text-xs text-muted-foreground italic">Chat published</span>
{:else if pendingCount === 0}
  <span class="text-xs text-muted-foreground">No pending changes</span>
{:else}
  <div class="inline-flex" data-testid="stage-deploy">
    <form
      method="post"
      action="?/stageAndDeployStaging"
      use:enhance={() => {
        staging = true;
        return async ({ update }) => {
          try {
            await update({ reset: false });
          } finally {
            // Always reset the spinner — including when the action
            // throws before the layout-level toast handler can fire.
            // Without try/finally the button would stay disabled and
            // the operator couldn't retry without a page reload.
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
        {staging ? "Staging…" : `Stage (${pendingCount})`}
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
      <DialogTitle>Publish to production</DialogTitle>
      <DialogDescription>
        Pick which entity kinds graduate to production. Unchecked kinds keep their current
        production HTML; checked kinds re-bake every page they touch.
      </DialogDescription>
    </DialogHeader>

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
          // Only close on success — on failure (e.g. CAPTCHA failed,
          // build error) the operator should see the picker still
          // populated with their kind selections so they can retry
          // without re-checking every box. The error itself surfaces
          // via the layout-level sonner toast (form.error path).
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
          {publishing ? "Publishing…" : "Publish to production"}
        </Button>
      </DialogFooter>
    </form>
  </DialogContent>
</Dialog>
