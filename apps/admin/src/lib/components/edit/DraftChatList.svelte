<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * The operator's own conversations with draft changes, one card each:
   * what the conversation changed in counts (new, changed, removed pages,
   * site-wide changes), "Stage now", "Open chat", and the single changes
   * behind "Show details". With several conversations, ticks pick which
   * ones a Stage takes and "Stage all" takes every one.
   *
   * Live Edit's Staging menu passes the conversation on screen: its card is
   * first, highlighted and the only one ticked (decision 2026-11-17).
   * Content → Changes passes none and adds Discard.
   *
   * One form for the whole list: "Stage now" posts `only`, "Stage all"
   * posts `all`, "Stage selected" the ticked `chatSessionId`s
   * (`#lib/server/stage-selection.ts` reads them).
   */
  import { enhance, type SubmitFunction } from "$app/forms";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { cn } from "#lib/utils.js";
  import {
    changeCount,
    chatContext,
    chatHref,
    countOf,
    type DraftChat,
    initialSelection,
    orderForDisplay,
    stageSelectedLabel,
    statChips,
    totalChanges,
  } from "./draft-chats.js";

  let {
    chats,
    activeChatId = null,
    action,
    csrfToken,
    canStage = true,
    busy = false,
    submit,
    hidden = {},
    discardFormId = null,
  }: {
    chats: readonly DraftChat[];
    /** Live Edit: the conversation on screen — first, highlighted, ticked. */
    activeChatId?: string | null;
    /** The form action that stages (`?/stageAndDeployStaging`, `?/stage`). */
    action: string;
    csrfToken: string;
    /** False without the Stage permission: the list is read-only. */
    canStage?: boolean;
    /** A Stage or Publish live is running: the stage buttons wait. */
    busy?: boolean;
    submit: SubmitFunction;
    /** Extra fields the action reads (Live Edit: the page on screen). */
    hidden?: Readonly<Record<string, string>>;
    /** Content → Changes: the id of a conversation's discard form. */
    discardFormId?: ((chatSessionId: string) => string) | null;
  } = $props();

  // The list mounts when the Staging menu opens, so every open starts from
  // the conversation on screen.
  let selected = $state(initialSelection(chats, activeChatId));
  let expanded = $state(new Set<string>());

  const ordered = $derived(orderForDisplay(chats, activeChatId));
  const several = $derived(chats.length > 1);
  const selectedButton = $derived(stageSelectedLabel(chats, selected));

  function toggleSelected(id: string, on: boolean): void {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    selected = next;
  }

  function toggleDetails(id: string): void {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }
</script>

<form method="post" {action} use:enhance={submit} class="space-y-2" data-testid="draft-chat-list">
  <input type="hidden" name="_csrf" value={csrfToken} />
  {#each Object.entries(hidden) as [name, value] (name)}
    <input type="hidden" {name} {value} />
  {/each}

  <ul class="space-y-1.5">
    {#each ordered as chat (chat.chatSessionId)}
      {@const active = chat.chatSessionId === activeChatId}
      {@const open = expanded.has(chat.chatSessionId)}
      <li
        class={cn(
          "flex gap-2.5 rounded-md border px-2.5 py-2",
          active ? "border-link/40 bg-link/5" : "border-transparent",
        )}
        data-testid="draft-chat"
        data-chat-id={chat.chatSessionId}
        data-active={active ? "true" : "false"}
      >
        {#if several && canStage}
          <input
            type="checkbox"
            name="chatSessionId"
            value={chat.chatSessionId}
            checked={selected.has(chat.chatSessionId)}
            onchange={(e) => toggleSelected(chat.chatSessionId, e.currentTarget.checked)}
            aria-label={`Select “${chat.title}”`}
            class="mt-1 size-4 shrink-0"
            data-testid="draft-chat-select"
          />
        {/if}
        <div class="min-w-0 flex-1 space-y-1">
          <div class="flex min-w-0 items-center gap-2">
            <span class="truncate text-sm font-medium" title={chat.title}>{chat.title}</span>
            {#if active}
              <Badge variant="secondary" class="shrink-0">This chat</Badge>
            {/if}
          </div>
          <p class="truncate text-xs text-muted-foreground">
            {chatContext(chat)} · {countOf(changeCount(chat), "change", "changes")}
          </p>
          {#if statChips(chat.summary).length > 0}
            <ul class="flex flex-wrap gap-1" data-testid="draft-chat-stats">
              {#each statChips(chat.summary) as chip (chip)}
                <li class="rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums">{chip}</li>
              {/each}
            </ul>
          {/if}
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-xs">
            {#if canStage}
              <Button
                type="submit"
                name="only"
                value={chat.chatSessionId}
                size="sm"
                variant="outline"
                class="h-7 px-2.5"
                disabled={busy}
                data-testid="stage-chat-now"
              >
                Stage now
              </Button>
            {/if}
            {#if !active}
              <a
                href={chatHref(chat)}
                class="text-link underline-offset-2 hover:underline"
                data-testid="open-chat-link">Open chat</a
              >
            {/if}
            {#if chat.summary.rows.length > 0}
              <button
                type="button"
                class="text-link underline-offset-2 hover:underline"
                aria-expanded={open}
                onclick={() => toggleDetails(chat.chatSessionId)}
                data-testid="draft-chat-details-toggle"
              >
                {open ? "Hide details" : "Show details"}
              </button>
            {/if}
            {#if discardFormId}
              <Button
                type="submit"
                form={discardFormId(chat.chatSessionId)}
                size="sm"
                variant="ghost"
                class="ml-auto h-7 px-2 text-red-700 dark:text-red-300"
                data-testid="discard-chat"
              >
                Discard…
              </Button>
            {/if}
          </div>
          {#if open}
            <ul
              class="max-h-60 space-y-0.5 overflow-y-auto border-t pt-1.5"
              data-testid="draft-chat-details"
            >
              {#each chat.summary.rows as row (row.key)}
                <li class="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs">
                  {#if row.change === "new"}
                    <span class="rounded bg-emerald-500/15 px-1 text-[10px] font-semibold text-emerald-800 dark:text-emerald-300">New</span>
                  {:else if row.change === "removed"}
                    <span class="rounded bg-red-500/15 px-1 text-[10px] font-semibold text-red-800 dark:text-red-300">Removed</span>
                  {/if}
                  <span class="min-w-0 font-medium [overflow-wrap:anywhere]">{row.title}</span>
                  {#if row.change === "changed"}
                    <span class="text-muted-foreground">{row.what}</span>
                  {/if}
                  {#if row.path}
                    <span class="min-w-0 font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{row.path}</span>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      </li>
    {/each}
  </ul>

  {#if canStage && several}
    <div class="flex flex-wrap gap-2 border-t pt-2">
      {#if selectedButton}
        <Button
          type="submit"
          size="sm"
          disabled={selectedButton.disabled || busy}
          data-testid="stage-selected"
        >
          {selectedButton.label}
        </Button>
      {/if}
      <Button
        type="submit"
        name="all"
        value="1"
        size="sm"
        variant="outline"
        disabled={busy}
        data-testid="stage-all"
      >
        Stage all ({totalChanges(chats)})
      </Button>
    </div>
  {/if}
</form>
