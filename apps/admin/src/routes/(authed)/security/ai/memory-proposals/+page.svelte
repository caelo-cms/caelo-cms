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
    <h1 class="text-2xl font-semibold tracking-tight">Memory proposals</h1>
    <p class="text-sm text-muted-foreground">
      Pending memory additions the AI proposed mid-conversation. Accepting replaces the slot's body.
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>Decision recorded.</AlertDescription></Alert>
  {/if}

  {#if data.proposals.length === 0}
    <Card>
      <CardContent class="py-8 text-center text-sm text-muted-foreground">
        <em>No pending proposals.</em>
      </CardContent>
    </Card>
  {:else}
    <ul class="space-y-3">
      {#each data.proposals as p (p.id)}
        <li>
          <Card>
            <CardHeader>
              <CardTitle class="flex items-center gap-2 text-base">
                <Badge variant="outline">{p.slot}</Badge>
                <span class="text-xs font-normal text-muted-foreground">proposed {p.createdAt}</span>
              </CardTitle>
            </CardHeader>
            <CardContent class="space-y-2">
              <pre class="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">{p.body}</pre>
              <p class="text-sm"><em>Rationale:</em> {p.rationale}</p>
              <div class="flex gap-2">
                <form method="post" action="?/review">
                  <input type="hidden" name="_csrf" value={data.csrfToken} />
                  <input type="hidden" name="proposalId" value={p.id} />
                  <input type="hidden" name="decision" value="accept" />
                  <Button type="submit" size="sm">Accept</Button>
                </form>
                <form method="post" action="?/review">
                  <input type="hidden" name="_csrf" value={data.csrfToken} />
                  <input type="hidden" name="proposalId" value={p.id} />
                  <input type="hidden" name="decision" value="reject" />
                  <Button type="submit" size="sm" variant="outline">Reject</Button>
                </form>
              </div>
            </CardContent>
          </Card>
        </li>
      {/each}
    </ul>
  {/if}
</div>
