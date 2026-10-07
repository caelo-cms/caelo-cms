<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Card, CardContent, CardHeader, CardTitle } from "#lib/components/ui/card/index.js";

  let { data, form } = $props();

  function lines(preview: Record<string, unknown>): string[] {
    const accepts = preview.accepts;
    return Array.isArray(accepts) ? accepts.map(String) : [];
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Pending quality decisions</h1>
    <p class="text-sm text-muted-foreground">
      Quality findings the AI asked an editor to accept, and requests to publish although the
      quality check failed. Decisions made in a chat are approved there; these came from outside
      a chat.
    </p>
  </div>

  {#if data.loadError}
    <Alert variant="destructive"><AlertDescription>{data.loadError}</AlertDescription></Alert>
  {/if}
  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {:else if form?.message}
    <Alert><AlertDescription>{form.message}</AlertDescription></Alert>
  {/if}

  {#if data.proposals.length === 0}
    <Card>
      <CardContent class="py-12 text-center text-sm text-muted-foreground">
        No pending quality decisions.
      </CardContent>
    </Card>
  {:else}
    <div class="space-y-4">
      {#each data.proposals as p (p.id)}
        <Card data-testid="quality-proposal">
          <CardHeader>
            <CardTitle class="flex items-center gap-2 text-base">
              <Badge variant={p.kind === "publish_anyway" ? "destructive" : "secondary"}>
                {p.kind === "accept" ? "accept findings" : "publish anyway"}
              </Badge>
              <span class="ml-auto text-xs font-normal text-muted-foreground">
                proposed {new Date(p.createdAt).toISOString().slice(0, 19)}Z
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent class="space-y-3 text-sm">
            {#if p.kind === "accept"}
              <ul class="list-disc pl-5">
                {#each lines(p.preview) as line (line)}<li>{line}</li>{/each}
              </ul>
              <p class="text-xs text-muted-foreground">
                Applies only to these pages; the same finding on another page still blocks.
              </p>
            {:else}
              <p>Failed check: {String(p.preview.failedCheck ?? "")}</p>
            {/if}
            <p><span class="font-medium">Reason:</span> {String(p.preview.reason ?? "")}</p>
            <div class="flex items-center gap-2 pt-1">
              <form method="post" action="?/approve">
                <input type="hidden" name="_csrf" value={data.csrfToken} />
                <input type="hidden" name="proposalId" value={p.id} />
                <input type="hidden" name="kind" value={p.kind} />
                <Button type="submit" variant={p.kind === "publish_anyway" ? "destructive" : "default"}>
                  Approve
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
