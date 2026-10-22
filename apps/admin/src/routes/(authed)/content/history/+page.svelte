<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { confirmSubmit } from "#lib/confirm.svelte.js";
  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button, buttonVariants } from "#lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";

  let { data, form } = $props();
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Advanced history</h1>
    <p class="text-sm text-muted-foreground">
      Every site snapshot. Reverts append a new entry — history is never destructively rewound.
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}

  {#if data.snapshots.length === 0}
    <Card>
      <CardContent class="py-8 text-center text-sm text-muted-foreground">
        <em>No snapshots yet.</em>
      </CardContent>
    </Card>
  {:else}
    <ul class="space-y-3">
      {#each data.snapshots as s (s.id)}
        <li><Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2 text-base">
              {s.description}
              {#if s.revertOf}
                <Badge variant="outline">revert of {s.revertOf.slice(0, 8)}</Badge>
              {/if}
            </CardTitle>
            <CardDescription>
              {s.createdAt} — modules:{s.moduleCount}, templates:{s.templateCount}, pages:{s.pageCount},
              layouts:{s.pageLayoutCount}
            </CardDescription>
          </CardHeader>
          <CardContent class="flex flex-wrap gap-2">
            <a class={buttonVariants({ variant: "outline", size: "sm" })} href={`/content/history/${s.id}`}>
              View entities
            </a>
            {#if s.moduleCount + s.templateCount + s.pageCount + s.pageLayoutCount > 0}
              <form
                method="post"
                action="?/revertSite"
                use:confirmSubmit={{ title: "Revert the entire site to this snapshot?", description: "A new snapshot is added to the history, so you can undo this there.", confirmLabel: "Revert site" }}
              >
                <input type="hidden" name="_csrf" value={data.csrfToken} />
                <input type="hidden" name="snapshotId" value={s.id} />
                <Button type="submit" variant="destructive" size="sm">Revert site to here</Button>
              </form>
            {/if}
          </CardContent>
        </Card></li>
      {/each}
    </ul>
  {/if}
</div>
