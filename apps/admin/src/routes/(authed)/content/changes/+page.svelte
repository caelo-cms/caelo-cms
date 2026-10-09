<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { GitPullRequestArrow } from "lucide-svelte";
  import EmptyStatePlaceholder from "#lib/components/EmptyStatePlaceholder.svelte";
  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Card, CardContent, CardHeader, CardTitle } from "#lib/components/ui/card/index.js";

  let { data, form } = $props();

  type Chat = (typeof data.chats)[number];
  type Ref = Chat["changes"]["pending"]["pages"][number];

  const ownStageable = $derived(data.chats.filter((c) => c.isMine && c.pendingCount > 0));

  const groups = (c: Chat): { label: string; refs: Ref[] }[] =>
    [
      { label: "Pages", refs: c.changes.pending.pages },
      { label: "Site-wide", refs: c.changes.pending.globals },
      { label: "Lists", refs: c.changes.pending.lists },
    ].filter((g) => g.refs.length > 0);

  const when = (iso: string): string => iso.slice(0, 16).replace("T", " ");
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Open changes</h1>
    <p class="text-sm text-muted-foreground">
      Unstaged work across your chats. Stage sends the selected chats to the staging site in one
      build; Publish live happens after you review staging. When a chat edits something another chat
      holds, it takes that chat's change over — nothing is lost.
    </p>
  </div>

  {#if data.loadError}
    <Alert variant="destructive"><AlertDescription>{data.loadError}</AlertDescription></Alert>
  {/if}
  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.staged}
    <Alert>
      <AlertDescription>
        Staged {form.staged.chatCount} chat(s): {form.staged.mergedEntityCount} change(s) are on the
        staging site — <a class="underline" href={form.staged.previewUrl}>open the preview</a>.
        {#if form.staged.draftPageCount > 0}
          {form.staged.draftPageCount} draft page(s) are not in this build.
        {/if}
        {#if form.staged.brokenInternalLinks.length > 0}
          Broken internal links: {form.staged.brokenInternalLinks.join(", ")}.
        {/if}
      </AlertDescription>
    </Alert>
  {/if}

  {#if data.chats.length === 0 && !data.loadError}
    <EmptyStatePlaceholder
      icon={GitPullRequestArrow}
      title="Nothing open"
      description="No chat has unstaged changes. Ask the AI for a change in Live edit — it shows up here until it is staged."
    />
  {:else}
    <form id="stage-form" method="post" action="?/stage" class="space-y-4">
      <input type="hidden" name="_csrf" value={data.csrfToken} />
      {#if data.canStage && ownStageable.length > 0}
        <div class="flex flex-wrap items-center gap-2">
          <Button type="submit" name="all" value="1" data-testid="stage-all">
            Stage all ({ownStageable.length})
          </Button>
          <Button type="submit" variant="secondary" data-testid="stage-selected">
            Stage selected
          </Button>
        </div>
      {/if}

      {#each data.chats as c (c.chatSessionId)}
        <Card data-testid="open-chat" data-chat-id={c.chatSessionId}>
          <CardHeader class="pb-2">
            <div class="flex flex-wrap items-center gap-3">
              {#if c.isMine && c.pendingCount > 0 && data.canStage}
                <input
                  type="checkbox"
                  name="chatSessionId"
                  value={c.chatSessionId}
                  aria-label={`Select chat ${c.title}`}
                  class="size-4"
                />
              {/if}
              <CardTitle class="text-base">
                {#if c.isMine}
                  <a
                    class="underline-offset-4 hover:underline"
                    href={`/edit?chat=${c.chatSessionId}`}>{c.title}</a
                  >
                {:else}
                  <!-- Another editor's chat cannot be opened here: /edit
                       only resumes the operator's own chats. -->
                  <span data-testid="foreign-chat-title">{c.title}</span>
                {/if}
              </CardTitle>
              {#if c.isMine}
                <Badge variant="secondary">your chat</Badge>
              {:else}
                <Badge variant="outline">another editor</Badge>
              {/if}
              {#if c.anchorPageSlug}
                <Badge variant="outline">/{c.anchorPageSlug}</Badge>
              {/if}
              <Badge variant={c.pendingCount > 0 ? "warning" : "secondary"}>
                {c.pendingCount} unstaged
              </Badge>
              <span class="text-xs text-muted-foreground">active {when(c.lastActiveAt)}</span>
              {#if c.isMine}
                <Button
                  type="submit"
                  form={`discard-${c.chatSessionId}`}
                  variant="destructive"
                  size="sm"
                  class="ml-auto"
                  data-testid="discard-chat">Discard</Button
                >
              {/if}
            </div>
          </CardHeader>
          <CardContent class="space-y-3 text-sm">
            {#each groups(c) as g (g.label)}
              <div>
                <div class="font-medium">{g.label}</div>
                <ul class="ml-4 list-disc text-muted-foreground">
                  {#each g.refs as r (`${r.kind}:${r.entityId}`)}
                    <li>{r.label}{r.detail ? ` — ${r.detail}` : ""}</li>
                  {/each}
                </ul>
              </div>
            {/each}
            {#if c.locks.length > 0}
              <div>
                <div class="font-medium">Holds</div>
                <p class="text-muted-foreground">
                  {c.locks.map((l) => `${l.label} (${l.entityKind})`).join(", ")}
                </p>
              </div>
            {/if}
            {#if c.takeovers.length > 0}
              <div>
                <div class="font-medium">Taken over</div>
                <ul class="ml-4 list-disc text-muted-foreground" data-testid="takeovers">
                  {#each c.takeovers as t, i (`${t.at}:${i}`)}
                    <li>
                      {#if t.direction === "adopted"}
                        Adopted {t.entityKind} '{t.label}' from chat '{t.otherChatTitle}' ({when(t.at)})
                      {:else}
                        Chat '{t.otherChatTitle}' took over {t.entityKind} '{t.label}' ({when(t.at)})
                      {/if}
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}
          </CardContent>
        </Card>
      {/each}
    </form>

    {#each data.chats.filter((c) => c.isMine) as c (c.chatSessionId)}
      <form
        id={`discard-${c.chatSessionId}`}
        method="post"
        action="?/discard"
        class="hidden"
        onsubmit={(e) => {
          if (
            !confirm(
              `Discard chat '${c.title}'? Its ${c.pendingCount} unstaged change(s) are thrown away and the chat is closed. This cannot be undone.`,
            )
          ) {
            e.preventDefault();
          }
        }}
      >
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <input type="hidden" name="chatSessionId" value={c.chatSessionId} />
      </form>
    {/each}
  {/if}
</div>
