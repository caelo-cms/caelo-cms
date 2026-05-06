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
    <h1 class="text-2xl font-semibold tracking-tight">Pending snapshot reverts</h1>
    <p class="text-sm text-muted-foreground">
      AI-proposed snapshot reverts (site / page / template / module) wait here for your click. The
      preview shows the snapshot's age + chat origin and the affected entity counts so you can see
      how much will be rewound before approving. A site revert can rewind hundreds of pages with
      one click — read the preview before approving.
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {:else if form?.message}
    <Alert><AlertDescription>{form.message}</AlertDescription></Alert>
  {/if}

  {#if data.proposals.length === 0}
    <Card>
      <CardContent class="py-12 text-center text-sm text-muted-foreground">
        No pending revert proposals. AI-driven snapshot reverts will land here.
      </CardContent>
    </Card>
  {:else}
    <div class="space-y-4">
      {#each data.proposals as p (p.id)}
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2 text-base">
              <Badge variant={p.kind === "site" ? "destructive" : "secondary"}>revert {p.kind}</Badge>
              <span class="font-mono text-xs">{p.id.slice(0, 8)}…</span>
              <span class="ml-auto text-xs font-normal text-muted-foreground">
                proposed {new Date(p.createdAt).toISOString().slice(0, 19)}Z
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent class="space-y-3 text-sm">
            <details class="rounded border bg-muted/30 p-2" open>
              <summary class="cursor-pointer text-xs font-medium">Preview (blast radius)</summary>
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
                <Button type="submit" variant={p.kind === "site" ? "destructive" : "default"}>
                  Approve revert
                </Button>
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
