<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * v0.12.4 — placement sync-mode toggle.
   *
   * Rendered next to each placement in /content/pages/[id]. Posts to
   * the `setPlacementContent` / `forkPlacementContent` form actions on
   * the parent page-server so the operator can:
   *
   *   - Flip a placement from unsynced → synced by picking a content
   *     instance from the library (URL-linked, since the picker UI is
   *     a v0.12.4+ polish item). For now the toggle exposes a textbox
   *     for the contentInstanceId so the operator can paste an id
   *     from /content/library, or click the convenience link.
   *   - Flip synced → unsynced by clicking "edit only this page",
   *     which forks the placement into a private content_instance.
   *
   * The Fork affordance is the "make local edits" shortcut the issue
   * AC #8 specifies — a single click detaches without leaving the page.
   */
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";

  interface Props {
    pageId: string;
    blockName: string;
    position: number;
    syncMode: "synced" | "unsynced";
    contentInstanceId: string | null;
    csrfToken: string;
  }
  let { pageId, blockName, position, syncMode, contentInstanceId, csrfToken }: Props = $props();
</script>

<div class="flex items-center gap-2 text-xs">
  {#if syncMode === "synced"}
    <Badge variant="default">synced</Badge>
    {#if contentInstanceId}
      <a
        href={`/content/library/${contentInstanceId}`}
        class="text-muted-foreground underline-offset-2 hover:underline"
      >
        edit shared content
      </a>
      <span class="text-muted-foreground">·</span>
    {/if}
    <form method="post" action="?/forkPlacementContent" class="inline">
      <input type="hidden" name="_csrf" value={csrfToken} />
      <input type="hidden" name="pageId" value={pageId} />
      <input type="hidden" name="blockName" value={blockName} />
      <input type="hidden" name="position" value={position} />
      <Button
        type="submit"
        size="sm"
        variant="link"
        class="h-auto px-0 text-xs"
        title="Detach this placement into a private content_instance so edits stay local to this page"
      >
        edit only this page
      </Button>
    </form>
  {:else}
    <Badge variant="outline">unsynced</Badge>
    <form
      method="post"
      action="?/setPlacementContent"
      class="inline-flex items-center gap-1"
      aria-label="Bind to a shared content_instance"
    >
      <input type="hidden" name="_csrf" value={csrfToken} />
      <input type="hidden" name="pageId" value={pageId} />
      <input type="hidden" name="blockName" value={blockName} />
      <input type="hidden" name="position" value={position} />
      <input type="hidden" name="syncMode" value="synced" />
      <input
        type="text"
        name="contentInstanceId"
        placeholder="paste content_instance UUID from /content/library"
        class="h-7 w-72 rounded border px-2 text-xs"
        pattern="[0-9a-fA-F-]{36}"
        required
      />
      <Button type="submit" size="sm" variant="outline" class="h-7 px-2 text-xs">
        share with another page
      </Button>
    </form>
  {/if}
</div>
