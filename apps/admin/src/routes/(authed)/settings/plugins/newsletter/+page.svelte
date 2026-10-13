<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Mail } from "lucide-svelte";
  import { enhance } from "$app/forms";
  import { Button } from "#lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";
  import { Input } from "#lib/components/ui/input/index.js";

  let { data, form } = $props();
</script>

<div class="space-y-6">
  <div>
    <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <Mail class="size-6" />
      Newsletter
    </h1>
    <p class="text-sm text-muted-foreground">
      Draft a campaign with AI assistance, then queue it to subscribers. Sends drain via the
      <code>drain_sends</code> worker (every minute).
    </p>
  </div>

  {#if form?.error}
    <div class="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">{form.error}</div>
  {/if}
  {#if form?.ok}
    <div class="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-700 dark:bg-green-950 dark:text-green-300">{form.message}</div>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle>Draft a new campaign</CardTitle>
      <CardDescription>AI generates the body HTML from your brief.</CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/draft" use:enhance class="grid gap-3 max-w-xl">
        <label class="grid gap-1 text-sm">
          <span>Slug</span>
          <Input name="slug" placeholder="spring-launch" required />
        </label>
        <label class="grid gap-1 text-sm">
          <span>Subject</span>
          <Input name="subject" placeholder="Our spring lineup is here" required />
        </label>
        <label class="grid gap-1 text-sm">
          <span>Brief (what should the AI write about?)</span>
          <textarea name="brief" required rows="4" class="rounded border px-3 py-2 text-sm"></textarea>
        </label>
        <div>
          <Button type="submit">Draft with AI</Button>
        </div>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle>Send a draft campaign</CardTitle>
      <CardDescription>Queues per-subscriber sends; the worker drains them within a minute.</CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/send" use:enhance class="grid gap-3 max-w-xl">
        <label class="grid gap-1 text-sm">
          <span>Campaign id</span>
          <Input name="campaignId" placeholder="uuid…" required />
        </label>
        <div>
          <Button type="submit">Queue sends</Button>
        </div>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle>Campaigns</CardTitle>
      <CardDescription>
        {data.subscriberCount === null
          ? "Subscriber count unavailable."
          : `${data.subscriberCount} confirmed subscriber(s) receive a send.`}
        The AI can list, draft and (with your approval) send campaigns too.
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.error}
        <p class="text-sm text-red-700 dark:text-red-300">{data.error}</p>
      {:else if data.campaigns.length === 0}
        <p class="text-sm text-muted-foreground">No campaigns yet.</p>
      {:else}
        <ul class="space-y-1 text-sm">
          {#each data.campaigns as c (c.id)}
            <li class="flex flex-wrap items-center gap-2">
              <span class="font-medium">{c.subject}</span>
              <span class="text-xs text-muted-foreground">{c.slug} · {c.status}</span>
              <code class="text-xs">{c.id}</code>
            </li>
          {/each}
        </ul>
      {/if}
    </CardContent>
  </Card>
</div>
