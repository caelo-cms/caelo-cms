<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { MessageSquare, Sparkles } from "lucide-svelte";
  import { enhance } from "$app/forms";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";

  let { data, form } = $props();
  let selected = $state<Set<string>>(new Set());
  let bulkDecision = $state<"approved" | "rejected" | "spam">("approved");

  function toggle(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  }

  function fmt(s: string): string {
    return new Date(s).toLocaleString();
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <MessageSquare class="size-6" />
      Comment moderation
    </h1>
    <p class="text-sm text-muted-foreground">
      Visitor comments awaiting review. Use AI moderation for an instant verdict, or moderate
      manually with the per-row buttons.
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
      <CardTitle>Pending queue</CardTitle>
      <CardDescription>{data.comments.length} comments awaiting moderation</CardDescription>
    </CardHeader>
    <CardContent class="space-y-4">
      {#if data.comments.length === 0}
        <p class="text-sm text-muted-foreground">No comments awaiting moderation.</p>
      {:else}
        {#if selected.size > 0}
          <form method="post" action="?/bulkModerate" use:enhance class="flex items-center gap-2 rounded border bg-accent/50 p-3">
            <input type="hidden" name="commentIds" value={[...selected].join(",")} />
            <span class="text-sm font-medium">{selected.size} selected</span>
            <select bind:value={bulkDecision} name="decision" class="rounded border px-2 py-1 text-sm">
              <option value="approved">Approve</option>
              <option value="rejected">Reject</option>
              <option value="spam">Mark spam</option>
            </select>
            <Button type="submit" size="sm">Apply to selected</Button>
          </form>
        {/if}
        {#each data.comments as c (c.id)}
          <div class="rounded border p-3">
            <div class="mb-2 flex items-center justify-between gap-2">
              <label class="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={selected.has(c.id)} onchange={() => toggle(c.id)} />
                <span class="font-medium">{c.author_name}</span>
                <Badge variant="outline">page: {c.page_id.slice(0, 8)}</Badge>
                <Badge variant="outline">{c.locale}</Badge>
                <span class="text-xs text-muted-foreground">{fmt(c.submitted_at)}</span>
              </label>
              <form method="post" action="?/aiModerate" use:enhance>
                <input type="hidden" name="commentId" value={c.id} />
                <Button type="submit" size="sm" variant="secondary" class="gap-1"><Sparkles class="size-3" /> AI moderate</Button>
              </form>
            </div>
            <p class="mb-3 whitespace-pre-wrap text-sm">{c.content}</p>
            <div class="flex justify-end gap-2">
              <form method="post" action="?/moderate" use:enhance>
                <input type="hidden" name="commentId" value={c.id} />
                <input type="hidden" name="decision" value="approved" />
                <Button type="submit" size="sm">Approve</Button>
              </form>
              <form method="post" action="?/moderate" use:enhance>
                <input type="hidden" name="commentId" value={c.id} />
                <input type="hidden" name="decision" value="rejected" />
                <Button type="submit" size="sm" variant="outline">Reject</Button>
              </form>
              <form method="post" action="?/moderate" use:enhance>
                <input type="hidden" name="commentId" value={c.id} />
                <input type="hidden" name="decision" value="spam" />
                <Button type="submit" size="sm" variant="destructive">Spam</Button>
              </form>
            </div>
          </div>
        {/each}
      {/if}
    </CardContent>
  </Card>
</div>
