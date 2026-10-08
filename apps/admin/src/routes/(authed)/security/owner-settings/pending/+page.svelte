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
    set_ai_budget: "AI budget",
    set_ai_pricing: "AI pricing",
    set_gateway_settings: "Gateway settings",
    set_translation_model: "Translation model",
    set_plugin_ai_cost_cap: "Plugin AI cost cap",
    rotate_gateway_cookie_secret: "Rotate gateway cookie secret",
  };
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Pending settings changes</h1>
    <p class="text-sm text-muted-foreground">
      AI-proposed changes to AI budgets, AI pricing, the translation model and the public gateway wait here when they
      were proposed outside the chat (for example by an external agent over MCP). Each card shows
      the current value next to the proposed one; nothing changes until you approve.
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
        No pending settings proposals.
      </CardContent>
    </Card>
  {:else}
    <div class="space-y-4">
      {#each data.proposals as p (p.id)}
        <div data-testid="owner-settings-proposal">
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2 text-base">
              <Badge variant="secondary">{kindLabel[p.kind] ?? p.kind}</Badge>
              <span class="font-mono text-xs">{p.id.slice(0, 8)}…</span>
              <span class="ml-auto text-xs font-normal text-muted-foreground">
                proposed {new Date(p.createdAt).toISOString().slice(0, 19)}Z
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent class="space-y-3 text-sm">
            <p>{String(p.preview.summary ?? "")}</p>
            {#if p.preview.reason}
              <p><span class="font-medium">Reason:</span> {String(p.preview.reason)}</p>
            {/if}
            {#if p.preview.effect}
              <p class="text-muted-foreground">{String(p.preview.effect)}</p>
            {/if}
            {#if p.preview.changes}
              <details class="rounded border bg-muted/30 p-2">
                <summary class="cursor-pointer text-xs font-medium">Current → proposed</summary>
                <pre class="mt-2 overflow-x-auto text-xs">{JSON.stringify(p.preview.changes, null, 2)}</pre>
              </details>
            {/if}
            <div class="flex flex-wrap items-center gap-2">
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
                  aria-label="Reject reason (optional)"
                  placeholder="reject reason (optional)"
                  class="rounded-md border bg-background p-1.5 text-xs"
                />
                <Button type="submit" variant="ghost">Reject</Button>
              </form>
            </div>
          </CardContent>
        </Card>
        </div>
      {/each}
    </div>
  {/if}
</div>
