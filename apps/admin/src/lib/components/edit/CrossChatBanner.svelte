<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * v0.8.0 — cross-chat awareness banner.
   *
   * When the operator is viewing /edit on one page but has *other* open
   * chats with pending changes (on different pages), this banner names
   * those pages so the work doesn't get forgotten. Hidden when there
   * are no other open chats with pending — banner takes up zero space
   * in the empty-state.
   *
   * Each entry links back to the page that the chat is anchored to.
   * Clicking jumps the iframe + auto-resumes that chat.
   */
  import { AlertCircle } from "lucide-svelte";

  interface OtherChat {
    chatSessionId: string;
    title: string;
    anchorPageId: string | null;
    anchorPageSlug: string | null;
    anchorPageLocale: string | null;
    pendingCount: number;
  }

  let { chats }: { chats: OtherChat[] } = $props();

  // Default-locale (en) gets a bare /slug; others get /<locale>/slug
  // so the link matches the operator's mental URL.
  function hrefFor(c: OtherChat): string {
    if (!c.anchorPageId) return "/edit";
    return `/edit?page=${c.anchorPageId}&chat=${c.chatSessionId}`;
  }
  function labelFor(c: OtherChat): string {
    if (!c.anchorPageSlug) return c.title || "global chat";
    const slug = c.anchorPageSlug;
    return c.anchorPageLocale && c.anchorPageLocale !== "en"
      ? `/${c.anchorPageLocale}/${slug}`
      : `/${slug}`;
  }
</script>

{#if chats.length > 0}
  <div
    class="z-30 flex h-9 shrink-0 items-center gap-2 border-b bg-amber-500/10 px-3 text-xs text-amber-900 dark:text-amber-200"
    data-testid="cross-chat-banner"
  >
    <AlertCircle class="size-3.5 shrink-0" />
    <span class="font-medium">Also pending:</span>
    <ul class="flex flex-wrap items-center gap-x-3 gap-y-0.5">
      {#each chats as c (c.chatSessionId)}
        <li>
          <a
            href={hrefFor(c)}
            class="underline decoration-amber-700/50 underline-offset-2 hover:decoration-amber-700"
            data-testid="cross-chat-link"
          >
            {c.pendingCount}
            change{c.pendingCount === 1 ? "" : "s"}
            on
            <span class="font-mono">{labelFor(c)}</span>
          </a>
        </li>
      {/each}
    </ul>
    <span class="ml-auto text-amber-900/70 dark:text-amber-200/70">
      Stage them before deploying so nothing's left behind.
    </span>
  </div>
{/if}
