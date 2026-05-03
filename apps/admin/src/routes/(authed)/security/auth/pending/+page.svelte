<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Inbox, Lock } from "lucide-svelte";
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

  function fmt(s: string): string {
    return new Date(s).toLocaleString();
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <Inbox class="size-6" />
      Pending auth config proposals
    </h1>
    <p class="text-sm text-muted-foreground">
      AI proposes via <code>propose_auth_config</code>; the change is queued here. Click Approve to
      apply, or Reject (with optional reason) to dismiss. Owner-only — AI can't bypass this gate.
    </p>
  </div>

  {#if form?.error}
    <div class="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">{form.error}</div>
  {/if}
  {#if form?.ok}
    <div class="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-700 dark:bg-green-950 dark:text-green-300">{form.message}</div>
  {/if}
  {#if data.error}
    <div class="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">Could not load proposals: {data.error}</div>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle>Pending</CardTitle>
      <CardDescription>{data.proposals.length} awaiting review</CardDescription>
    </CardHeader>
    <CardContent class="space-y-3">
      {#if data.proposals.length === 0}
        <p class="text-sm text-muted-foreground">No pending proposals.</p>
      {:else}
        {#each data.proposals as p (p.id)}
          <div class="rounded border p-3">
            <div class="mb-2 flex items-center gap-2">
              <Lock class="size-4" />
              <span class="text-sm font-medium">Proposed by visitor {p.proposed_by.slice(0, 8)}</span>
              <Badge variant="outline">{fmt(p.created_at)}</Badge>
            </div>
            <ul class="mb-3 ml-6 list-disc text-sm">
              <li>Signup open: <strong>{p.proposed_signup_open ? "yes" : "no"}</strong></li>
              <li>Password min length: <strong>{p.proposed_password_min_length}</strong></li>
            </ul>
            <div class="flex gap-2">
              <form method="post" action="?/approve" use:enhance>
                <input type="hidden" name="proposalId" value={p.id} />
                <Button type="submit" size="sm">Approve</Button>
              </form>
              <form method="post" action="?/reject" use:enhance class="flex items-center gap-2">
                <input type="hidden" name="proposalId" value={p.id} />
                <input name="reason" placeholder="Reason (optional)" class="rounded border px-2 py-1 text-sm" />
                <Button type="submit" size="sm" variant="outline">Reject</Button>
              </form>
            </div>
          </div>
        {/each}
      {/if}
    </CardContent>
  </Card>
</div>
