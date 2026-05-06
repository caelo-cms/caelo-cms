<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";

  let { data, form } = $props();
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Pending user actions</h1>
    <p class="text-sm text-muted-foreground">
      AI-proposed user invitations, role changes, and deletions wait here for your click. Approving
      a <code>create</code> proposal generates a one-time temporary password — it appears here once
      and is never shown again, so copy it before navigating away.
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {:else if form?.temporaryPassword}
    <Alert>
      <AlertDescription>
        <div class="space-y-1">
          <div>{form.message}</div>
          <div>
            One-time password (copy now — not shown again):
            <code class="select-all rounded bg-muted px-2 py-1 font-mono text-sm">
              {form.temporaryPassword}
            </code>
          </div>
        </div>
      </AlertDescription>
    </Alert>
  {:else if form?.message}
    <Alert><AlertDescription>{form.message}</AlertDescription></Alert>
  {/if}

  {#if data.proposals.length === 0}
    <Card>
      <CardContent class="py-12 text-center text-sm text-muted-foreground">
        No pending user proposals. AI-driven invites and role changes will land here.
      </CardContent>
    </Card>
  {:else}
    <div class="space-y-4">
      {#each data.proposals as p (p.id)}
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2 text-base">
              <Badge variant="secondary">{p.kind}</Badge>
              <span class="font-mono text-xs">{p.id.slice(0, 8)}…</span>
              <span class="ml-auto text-xs font-normal text-muted-foreground">
                proposed {new Date(p.createdAt).toISOString().slice(0, 19)}Z
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent class="space-y-3 text-sm">
            <details class="rounded border bg-muted/30 p-2" open>
              <summary class="cursor-pointer text-xs font-medium">Preview</summary>
              <pre class="mt-2 text-xs">{JSON.stringify(p.preview, null, 2)}</pre>
            </details>
            <details class="rounded border bg-muted/30 p-2">
              <summary class="cursor-pointer text-xs font-medium">Original payload</summary>
              <pre class="mt-2 text-xs">{JSON.stringify(p.payload, null, 2)}</pre>
            </details>
            <div class="flex items-center gap-2 pt-1">
              <form method="post" action="?/approve">
                <input type="hidden" name="_csrf" value={data.csrfToken} />
                <input type="hidden" name="proposalId" value={p.id} />
                <Button type="submit">Approve</Button>
              </form>
              <form method="post" action="?/reject" class="flex items-center gap-2">
                <input type="hidden" name="_csrf" value={data.csrfToken} />
                <input type="hidden" name="proposalId" value={p.id} />
                <input
                  type="text"
                  name="reason"
                  placeholder="reject reason (optional)"
                  class="rounded-md border bg-background p-1.5 text-xs"
                />
                <Button type="submit" variant="ghost">Reject</Button>
              </form>
            </div>
          </CardContent>
        </Card>
      {/each}
    </div>
  {/if}
</div>
