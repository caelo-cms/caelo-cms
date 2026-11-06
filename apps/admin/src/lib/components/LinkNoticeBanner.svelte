<!-- SPDX-License-Identifier: MPL-2.0 -->
<script lang="ts">
  /**
   * #1240 — the links that keep a staged build from going live, with the
   * two ways out: hand the list to the AI, or take the linking pages back to
   * draft. One banner for the publish click, the Stage and the Publish-live
   * refusal, so all three read alike.
   */
  import { enhance } from "$app/forms";
  import type { LinkNotice } from "@caelo-cms/admin-core";
  import { Button, buttonVariants } from "#lib/components/ui/button/index.js";

  interface Props {
    notice: LinkNotice;
    csrfToken: string;
    /** Hands the list to the chat; absent where no chat is open. */
    onFix?: (prompt: string) => void;
    /** The form action that takes `pageIds` back to draft. */
    draftAction: string;
    /** Sent with the action: the chat the status change belongs to. */
    chat?: { readonly sessionId: string; readonly branchId: string } | null;
  }

  let { notice, csrfToken, onFix, draftAction, chat = null }: Props = $props();
</script>

<div
  class="space-y-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
  data-testid="link-notice"
>
  <p>{notice.operatorText}</p>
  <div class="flex flex-wrap gap-2">
    {#if onFix}
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="link-notice-fix"
        onclick={() => onFix?.(notice.fixPrompt)}
      >
        {notice.fixLabel}
      </Button>
    {:else}
      <a
        class={buttonVariants({ variant: "outline", size: "sm" })}
        href="/edit"
        data-testid="link-notice-open-editor">Open the editor</a
      >
    {/if}
    {#if notice.linkingPages.length > 0}
      <form method="post" action={draftAction} use:enhance>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input
          type="hidden"
          name="pageIds"
          value={notice.linkingPages.map((p) => p.id).join(",")}
        />
        {#if chat}
          <input type="hidden" name="chatSessionId" value={chat.sessionId} />
          <input type="hidden" name="chatBranchId" value={chat.branchId} />
        {/if}
        <Button type="submit" size="sm" variant="outline" data-testid="link-notice-back-to-draft">
          Back to draft
        </Button>
      </form>
    {/if}
  </div>
</div>
