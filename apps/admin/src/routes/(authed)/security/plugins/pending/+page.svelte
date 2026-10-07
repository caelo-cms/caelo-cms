<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";

  let { data, form } = $props();

  const kindLabel: Record<string, string> = {
    activate: "Activate",
    uninstall: "Uninstall",
    revoke_capability: "Revoke capability",
  };
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Pending plugin proposals</h1>
    <p class="text-sm text-muted-foreground">
      AI-proposed plugin activations, uninstalls and capability revocations wait here when they
      were proposed outside the chat (for example by an external agent over MCP). Nothing changes
      until you approve.
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
        No pending plugin proposals.
      </CardContent>
    </Card>
  {:else}
    <div class="space-y-4">
      {#each data.proposals as p (p.id)}
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2 text-base">
              <Badge variant={p.kind === "activate" ? "secondary" : "destructive"}>
                {kindLabel[p.kind] ?? p.kind}
              </Badge>
              <span>{String(p.preview.slug ?? "")}</span>
              <span class="ml-auto text-xs font-normal text-muted-foreground">
                proposed {new Date(p.createdAt).toISOString().slice(0, 19)}Z
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent class="space-y-3 text-sm">
            {#if p.preview.warning || p.preview.effect}
              <p>{String(p.preview.warning ?? p.preview.effect)}</p>
            {/if}
            <details class="rounded border bg-muted/30 p-2">
              <summary class="cursor-pointer text-xs font-medium">Preview</summary>
              <pre class="mt-2 overflow-x-auto text-xs">{JSON.stringify(p.preview, null, 2)}</pre>
            </details>
            <div class="flex flex-wrap items-center gap-2">
              <form method="post" action="?/approve">
                <input type="hidden" name="_csrf" value={data.csrfToken} />
                <input type="hidden" name="proposalId" value={p.id} />
                <input type="hidden" name="kind" value={p.kind} />
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
