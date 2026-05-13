<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * v0.5.5 — Stage / Publish picker for chat-branched changes.
   *
   * Renders three sections (Pages / Globals / Lists) from
   * `chat.list_pending_changes`. Operator ticks rows and clicks
   * Stage / Unstage / Publish staged. Sits in the chat sidebar
   * replacing the v0.4.0 publish card.
   *
   * Three-state recap (CMS_REQUIREMENTS §5):
   *   pending  → branch-private (only this chat sees it)
   *   staged   → shared overlay (every chat's preview)
   *   published → live in main
   */
  import { Button } from "$lib/components/ui/button";
  import { Card, CardContent, CardHeader, CardTitle } from "$lib/components/ui/card";

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

  // v0.5.8 — action overrides for hosts other than /content/chat. /edit
  // already has a `?/stage` action that drives the static-generator
  // pipeline (different stage concept); when StageSplitButton lives in
  // /edit it posts to dedicated chat-branch actions instead.
  let {
    pendingChanges,
    csrfToken,
    sessionPublished = false,
    stageAction = "?/stage",
    unstageAction = "?/unstage",
    publishAction = "?/publish",
    /** v0.5.8 — when set, every form includes a hidden chatSessionId
     *  field. /edit's chatStage/chatUnstage/chatPublishStaged actions
     *  need this since the route lacks a [sessionId] path param. */
    chatSessionId = null as string | null,
  }: {
    pendingChanges: PendingChangesView;
    csrfToken: string;
    sessionPublished?: boolean;
    stageAction?: string;
    unstageAction?: string;
    publishAction?: string;
    chatSessionId?: string | null;
  } = $props();

  const pendingCount = $derived(
    pendingChanges.pending.pages.length +
      pendingChanges.pending.globals.length +
      pendingChanges.pending.lists.length,
  );
  const stagedCount = $derived(
    pendingChanges.staged.pages.length +
      pendingChanges.staged.globals.length +
      pendingChanges.staged.lists.length,
  );

  // Selection state: a Set of "kind:entityId" strings. Lives across
  // section toggles so operators can select across categories before
  // hitting Stage / Unstage.
  let selected = $state(new Set<string>());

  function toggle(key: string): void {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selected = next;
  }

  function key(e: PendingEntity): string {
    return `${e.kind}:${e.entityId}`;
  }

  // Build the form's hidden `entity` inputs from the current selection.
  // Returns an array of {kind, id} so the template can iterate.
  function selectedAsList(): { kind: string; entityId: string }[] {
    const out: { kind: string; entityId: string }[] = [];
    for (const k of selected) {
      const [kind, id] = k.split(":");
      if (kind && id) out.push({ kind, entityId: id });
    }
    return out;
  }

  // Show / hide collapsible body.
  let open = $state(false);
</script>

<Card>
  <CardHeader>
    <CardTitle class="text-base">Stage & publish</CardTitle>
  </CardHeader>
  <CardContent class="space-y-3 text-sm">
    {#if sessionPublished}
      <p class="text-muted-foreground"><em>Already published.</em></p>
    {:else if pendingCount === 0 && stagedCount === 0}
      <p class="text-muted-foreground"><em>No pending changes.</em></p>
    {:else}
      <!-- top-line counts + primary action -->
      <div class="flex items-center gap-2">
        {#if stagedCount > 0}
          <form method="post" action={publishAction} class="contents">
            <input type="hidden" name="_csrf" value={csrfToken} />
            {#if chatSessionId}
              <input type="hidden" name="chatSessionId" value={chatSessionId} />
            {/if}
            <Button type="submit" size="sm">Publish staged ({stagedCount})</Button>
          </form>
        {:else if pendingCount > 0}
          <!-- No staged → "Stage all pending" stages everything in one click. -->
          <form method="post" action={stageAction} class="contents">
            <input type="hidden" name="_csrf" value={csrfToken} />
            {#if chatSessionId}
              <input type="hidden" name="chatSessionId" value={chatSessionId} />
            {/if}
            <Button type="submit" size="sm">Stage all ({pendingCount})</Button>
          </form>
        {/if}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onclick={() => {
            open = !open;
          }}
        >
          {open ? "Hide details" : "Pick specific"}
        </Button>
      </div>
      <p class="text-xs text-muted-foreground">
        {pendingCount} pending · {stagedCount} staged
      </p>

      {#if open}
        <div class="space-y-3 border-t pt-3">
          {#each [{ key: "pages", title: "Pages" }, { key: "globals", title: "Globals (modules, theme, templates)" }, { key: "lists", title: "Lists (nav-menu, taxonomy)" }] as section (section.key)}
            {@const sec = section.key as "pages" | "globals" | "lists"}
            {@const pending = pendingChanges.pending[sec]}
            {@const staged = pendingChanges.staged[sec]}
            {#if pending.length > 0 || staged.length > 0}
              <div>
                <h4 class="font-medium text-sm">{section.title}</h4>
                <ul class="space-y-1 mt-1">
                  {#each pending as e (key(e))}
                    <li>
                      <label class="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          class="h-3 w-3 rounded border-input"
                          checked={selected.has(key(e))}
                          onchange={() => toggle(key(e))}
                        />
                        <span class="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-300"
                          >pending</span
                        >
                        <span class="font-mono text-[10px] text-muted-foreground">{e.kind}</span>
                        <span class="truncate">{e.label}</span>
                        {#if e.detail}
                          <span class="text-muted-foreground truncate">— {e.detail}</span>
                        {/if}
                      </label>
                    </li>
                  {/each}
                  {#each staged as e (key(e))}
                    <li>
                      <label class="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          class="h-3 w-3 rounded border-input"
                          checked={selected.has(key(e))}
                          onchange={() => toggle(key(e))}
                        />
                        <span
                          class="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300"
                          >staged</span
                        >
                        <span class="font-mono text-[10px] text-muted-foreground">{e.kind}</span>
                        <span class="truncate">{e.label}</span>
                        {#if e.detail}
                          <span class="text-muted-foreground truncate">— {e.detail}</span>
                        {/if}
                      </label>
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}
          {/each}

          {#if selected.size > 0}
            <div class="flex flex-wrap items-center gap-2 border-t pt-2">
              <form method="post" action={stageAction} class="contents">
                <input type="hidden" name="_csrf" value={csrfToken} />
            {#if chatSessionId}
              <input type="hidden" name="chatSessionId" value={chatSessionId} />
            {/if}
                {#each selectedAsList() as e (`${e.kind}:${e.entityId}`)}
                  <input type="hidden" name="entity" value={`${e.kind}:${e.entityId}`} />
                {/each}
                <Button type="submit" size="sm" variant="outline">
                  Stage selected ({selected.size})
                </Button>
              </form>
              <form method="post" action={unstageAction} class="contents">
                <input type="hidden" name="_csrf" value={csrfToken} />
            {#if chatSessionId}
              <input type="hidden" name="chatSessionId" value={chatSessionId} />
            {/if}
                {#each selectedAsList() as e (`${e.kind}:${e.entityId}`)}
                  <input type="hidden" name="entity" value={`${e.kind}:${e.entityId}`} />
                {/each}
                <Button type="submit" size="sm" variant="outline">
                  Unstage selected
                </Button>
              </form>
              <form method="post" action={publishAction} class="contents">
                <input type="hidden" name="_csrf" value={csrfToken} />
            {#if chatSessionId}
              <input type="hidden" name="chatSessionId" value={chatSessionId} />
            {/if}
                {#each selectedAsList() as e (`${e.kind}:${e.entityId}`)}
                  <input type="hidden" name="entity" value={`${e.kind}:${e.entityId}`} />
                {/each}
                <Button type="submit" size="sm" variant="outline">
                  Publish selected
                </Button>
              </form>
            </div>
          {:else}
            <p class="text-xs text-muted-foreground">
              Tick rows above to stage or publish a subset.
            </p>
          {/if}
        </div>
      {/if}
    {/if}
  </CardContent>
</Card>
