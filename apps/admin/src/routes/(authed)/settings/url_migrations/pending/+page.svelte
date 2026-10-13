<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Card, CardContent, CardHeader, CardTitle } from "#lib/components/ui/card/index.js";

  let { data, form } = $props();

  const sampleOf = (preview: Record<string, unknown>): string[] =>
    Array.isArray(preview.sample) ? preview.sample.map(String) : [];
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Pending URL changes</h1>
    <p class="text-sm text-muted-foreground">
      After a plugin that shapes page addresses was turned on, off or reconfigured, the AI
      prepared moving the affected pages to their new addresses. Approving moves them and adds a
      permanent redirect from every old address, so links and search rankings keep working.
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
        No pending URL changes.
      </CardContent>
    </Card>
  {:else}
    <div class="space-y-4">
      {#each data.proposals as p (p.id)}
        {@const sample = sampleOf(p.preview)}
        <Card data-testid="url-migration-proposal">
          <CardHeader>
            <CardTitle class="flex items-center gap-2 text-base">
              <Badge variant="secondary">
                {String(p.preview.pagesMoved ?? "?")} page{p.preview.pagesMoved === 1 ? "" : "s"} move
              </Badge>
              <span class="font-mono text-xs">{p.id.slice(0, 8)}…</span>
              <span class="ml-auto text-xs font-normal text-muted-foreground">
                proposed {new Date(p.createdAt).toISOString().slice(0, 19)}Z
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent class="space-y-3 text-sm">
            {#if typeof p.preview.reason === "string"}
              <p>{p.preview.reason}</p>
            {/if}
            {#if sample.length > 0}
              <ul class="space-y-1 rounded border bg-muted/30 p-2 font-mono text-xs">
                {#each sample as line (line)}
                  <li>{line}</li>
                {/each}
              </ul>
            {/if}
            <p class="text-xs text-muted-foreground">
              {String(p.preview.redirectsToCreate ?? "?")} redirects will be created.
            </p>
            <div class="flex items-center gap-2 pt-1">
              <form method="post" action="?/approve">
                <input type="hidden" name="_csrf" value={data.csrfToken} />
                <input type="hidden" name="proposalId" value={p.id} />
                <Button type="submit">Approve URL change</Button>
              </form>
              <form method="post" action="?/reject" class="flex items-center gap-2">
                <input type="hidden" name="_csrf" value={data.csrfToken} />
                <input type="hidden" name="proposalId" value={p.id} />
                <input
                  type="text"
                  name="reason"
                  aria-label="Reject reason (optional)"
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
