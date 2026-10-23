<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Bug, GitPullRequestArrow, Inbox, MessageSquare, Sailboat, Wand2 } from "lucide-svelte";
  import StateDot from "#lib/components/StateDot.svelte";
  import { buttonVariants } from "#lib/components/ui/button/button-variants.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";

  let { data } = $props();
  const has = (p: string) => data.user.permissions.includes(p);
  const siteState = $derived(data.siteState);
  // UTC minute, same on server and client (no hydration drift).
  const when = (iso: string): string => `${iso.slice(0, 16).replace("T", " ")} UTC`;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  // The dashboard answers "what is going on, and where do I continue?".
  // Live edit is where the work happens, so the first card always leads
  // there: on a fresh install (nothing published yet) as the invitation to
  // set the site up, afterwards as "continue your last chat".
  const isFreshInstall = $derived(has("settings.write") && data.publishedPageCount === 0);
  const lastChat = $derived(data.recentChats?.[0] ?? null);
  const continueHref = $derived(lastChat ? `/edit?chat=${encodeURIComponent(lastChat.id)}` : "/edit");

  // Status cards appear only when they have something to say.
  const showOpenChanges = $derived((data.openChanges?.changeCount ?? 0) > 0);
  const showApprovals = $derived((data.pendingApprovals ?? 0) > 0);
  const showBugs = $derived((data.newBugReports ?? 0) > 0);
  const showRecentChats = $derived((data.recentChats?.length ?? 0) > 0);
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Welcome back</h1>
    <p class="text-sm text-muted-foreground">Signed in as <strong>{data.user.email}</strong></p>
  </div>

  {#if has("content.write")}
    <Card class="border-primary/40 bg-primary/5" data-testid="dashboard-live-edit">
      <CardHeader class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="space-y-1.5">
          {#if isFreshInstall}
            <CardTitle class="flex items-center gap-2 text-base">
              <Sailboat class="size-5" />
              Set up your site
            </CardTitle>
            <CardDescription>
              Open Live edit and tell the AI where to start: migrate an existing website, build
              from scratch, or bring your own design. You answer questions and approve the big
              steps; the AI does the work.
            </CardDescription>
          {:else}
            <CardTitle class="flex items-center gap-2 text-base">
              <Wand2 class="size-5" />
              Continue in Live edit
            </CardTitle>
            <CardDescription>
              {#if lastChat}
                Last chat: <span class="font-medium text-foreground">{lastChat.title}</span>,
                {when(lastChat.lastActiveAt)}.
              {:else}
                See your site and change it by telling the AI what you need.
              {/if}
            </CardDescription>
          {/if}
        </div>
        <a href={isFreshInstall ? "/edit" : continueHref} class={buttonVariants({ size: "lg" })}>
          {isFreshInstall ? "Start in Live edit" : "Open Live edit"}
        </a>
      </CardHeader>
    </Card>
  {/if}

  <!-- #779 — where the site stands, Draft → Preview → Live. -->
  {#if siteState && has("content.read")}
    <Card data-testid="site-state">
      <CardHeader class="pb-2">
        <CardTitle class="text-base">Site state</CardTitle>
      </CardHeader>
      <CardContent>
        <ul class="grid gap-2 text-sm sm:grid-cols-3">
          <li class="flex flex-col gap-0.5">
            <StateDot state="draft" class="text-sm font-medium" />
            <a class="text-muted-foreground underline-offset-4 hover:underline" href="/content/pages">
              {plural(siteState.draftPageCount, "draft page", "draft pages")}
            </a>
          </li>
          <li class="flex flex-col gap-0.5">
            <StateDot state="preview" class="text-sm font-medium" />
            <span class="text-muted-foreground">
              {siteState.preview ? `Staged ${when(siteState.preview.finishedAt)}` : "Nothing staged yet"}
            </span>
          </li>
          <li class="flex flex-col gap-0.5">
            <StateDot state="live" class="text-sm font-medium" />
            <span class="text-muted-foreground">
              {#if siteState.live}
                Published {when(siteState.live.finishedAt)}{siteState.liveMatchesPreview === false
                  ? " — a newer staged build is waiting"
                  : ""}
              {:else}
                Not published yet
              {/if}
            </span>
          </li>
        </ul>
      </CardContent>
    </Card>
  {/if}

  {#if showOpenChanges || showApprovals || showBugs || showRecentChats}
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
      {#if showOpenChanges && data.openChanges}
        <a href="/content/changes" class="block" data-testid="dashboard-open-changes">
          <Card class="h-full transition-colors hover:bg-accent">
            <CardHeader>
              <CardTitle class="flex items-center gap-2 text-base">
                <GitPullRequestArrow class="size-4" />
                Open changes
              </CardTitle>
              <CardDescription>
                {plural(data.openChanges.changeCount, "change", "changes")} in
                {plural(data.openChanges.chatCount, "chat", "chats")} not staged yet.
              </CardDescription>
            </CardHeader>
          </Card>
        </a>
      {/if}
      {#if showApprovals && data.pendingApprovals !== null}
        <a href="/settings/pending" class="block" data-testid="dashboard-approvals">
          <Card class="h-full transition-colors hover:bg-accent">
            <CardHeader>
              <CardTitle class="flex items-center gap-2 text-base">
                <Inbox class="size-4" />
                Waiting for your approval
              </CardTitle>
              <CardDescription>
                {plural(data.pendingApprovals, "thing the AI prepared needs", "things the AI prepared need")}
                your click.
              </CardDescription>
            </CardHeader>
          </Card>
        </a>
      {/if}
      {#if showRecentChats && data.recentChats}
        <Card data-testid="dashboard-recent-chats">
          <CardHeader class="pb-2">
            <CardTitle class="flex items-center gap-2 text-base">
              <MessageSquare class="size-4" />
              Recent chats
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul class="space-y-1.5 text-sm">
              {#each data.recentChats as chat (chat.id)}
                <li class="flex items-baseline justify-between gap-3">
                  <a
                    class="min-w-0 truncate underline-offset-4 hover:underline"
                    href={`/edit?chat=${encodeURIComponent(chat.id)}`}>{chat.title}</a
                  >
                  <span class="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {when(chat.lastActiveAt)}
                  </span>
                </li>
              {/each}
            </ul>
          </CardContent>
        </Card>
      {/if}
      {#if showBugs && data.newBugReports !== null}
        <a href="/settings/bugs" class="block" data-testid="dashboard-bugs">
          <Card class="h-full transition-colors hover:bg-accent">
            <CardHeader>
              <CardTitle class="flex items-center gap-2 text-base">
                <Bug class="size-4" />
                Detected bugs
              </CardTitle>
              <CardDescription>
                {plural(data.newBugReports, "new problem", "new problems")} the AI noticed while
                working.
              </CardDescription>
            </CardHeader>
          </Card>
        </a>
      {/if}
    </div>
  {/if}
</div>
