<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { GitPullRequestArrow } from "lucide-svelte";
  import type { SubmitFunction } from "$app/forms";
  import { confirmSubmit } from "#lib/confirm.svelte.js";
  import DraftChatList from "#lib/components/edit/DraftChatList.svelte";
  import EmptyStatePlaceholder from "#lib/components/EmptyStatePlaceholder.svelte";
  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";

  let { data, form } = $props();

  let staging = $state(false);
  const stage: SubmitFunction = () => {
    staging = true;
    return async ({ update }) => {
      try {
        await update({ reset: false });
      } finally {
        staging = false;
      }
    };
  };
  const discardFormId = (chatSessionId: string) => `discard-${chatSessionId}`;
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Draft changes</h1>
    <p class="max-w-prose text-sm text-muted-foreground">
      Your conversations with changes that are not on staging yet. Stage sends them to the staging
      site in one build and runs the quality check; Publish live happens after you review staging.
    </p>
  </div>

  {#if data.loadError}
    <Alert variant="destructive"><AlertDescription>{data.loadError}</AlertDescription></Alert>
  {/if}
  {#if form?.error}
    <Alert variant="destructive">
      <AlertDescription>
        {form.error}
        {#if "confirmDiscard" in form && form.confirmDiscard}
          <form method="post" action="?/discard" class="mt-2">
            <input type="hidden" name="_csrf" value={data.csrfToken} />
            <input type="hidden" name="chatSessionId" value={form.confirmDiscard} />
            <input type="hidden" name="confirmOverlap" value="1" />
            <Button type="submit" variant="destructive" size="sm" data-testid="discard-anyway">
              Discard anyway
            </Button>
          </form>
        {/if}
      </AlertDescription>
    </Alert>
  {/if}
  {#if form?.staged}
    <Alert>
      <AlertDescription>
        Staged {form.staged.chatCount === 1 ? "1 conversation" : `${form.staged.chatCount} conversations`}:
        the changes are on the staging site — <a class="underline" href={form.staged.previewUrl}>open the preview</a>.
        {#if form.staged.draftPageCount > 0}
          {form.staged.draftPageCount} draft page(s) are not in this build{form.staged.draftPageTitles.length > 0 ? ` (${form.staged.draftPageTitles.join(", ")}${form.staged.draftPageCount > form.staged.draftPageTitles.length ? ", …" : ""})` : ""} —
          only published pages are staged; set them to published and Stage again to include them.
        {/if}
        {#if form.staged.alsoIncludes.length > 0}
          Also staged, because they changed the same things: {form.staged.alsoIncludes.join(", ")}.
        {/if}
        {#if form.staged.linkWarnings.length > 0}
          Link warnings (links to unpublished pages block Publish live):
          {form.staged.linkWarnings.join(" · ")}
        {/if}
        {#if form.staged.unpublishedLinkWarning}
          {form.staged.unpublishedLinkWarning}
        {/if}
        {#if form.staged.truncatedListWarning}
          {form.staged.truncatedListWarning}
        {/if}
        {#if form.staged.linkNoticeWarning}
          <strong data-testid="stage-link-notice">{form.staged.linkNoticeWarning}</strong>
        {/if}
        {#if form.staged.pluginProblemWarning}
          <strong>{form.staged.pluginProblemWarning}</strong>
        {/if}
      </AlertDescription>
    </Alert>
  {/if}

  {#if data.chats.length === 0 && !data.loadError}
    <EmptyStatePlaceholder
      icon={GitPullRequestArrow}
      title="Nothing in draft"
      description="None of your conversations has changes that are not on staging. Ask the AI for a change in Live edit — it shows up here until it is staged."
    />
  {:else if data.chats.length > 0}
    <div class="max-w-3xl rounded-lg border p-3">
      <DraftChatList
        chats={data.chats}
        action="?/stage"
        csrfToken={data.csrfToken}
        canStage={data.canStage}
        busy={staging}
        submit={stage}
        {discardFormId}
      />
    </div>

    {#each data.chats as c (c.chatSessionId)}
      <form
        id={discardFormId(c.chatSessionId)}
        method="post"
        action="?/discard"
        class="hidden"
        use:confirmSubmit={{
          title: `Discard “${c.title}”?`,
          description: `Its draft changes are thrown away and the conversation is closed. This cannot be undone.`,
          confirmLabel: "Discard conversation",
        }}
      >
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <input type="hidden" name="chatSessionId" value={c.chatSessionId} />
      </form>
    {/each}
  {/if}
</div>
