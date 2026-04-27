<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Card, CardContent } from "$lib/components/ui/card/index.js";

  let { data, form } = $props();
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">
      History — {data.module?.slug ?? data.moduleId.slice(0, 8)}
    </h1>
    <p class="text-sm text-muted-foreground">
      Every snapshot that touched this module, reverse-chronological.
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}

  {#if data.snapshots.length === 0}
    <Card>
      <CardContent class="py-8 text-center text-sm text-muted-foreground">
        <em>No snapshots for this module yet.</em>
      </CardContent>
    </Card>
  {:else}
    <ul class="space-y-2">
      {#each data.snapshots as s (s.id)}
        <li>
          <Card>
            <CardContent class="flex items-center justify-between gap-4 py-4">
              <div class="text-sm">
                <strong>{s.description}</strong>
                {#if s.revertOf}
                  <Badge variant="outline" class="ml-2">revert of {s.revertOf.slice(0, 8)}</Badge>
                {/if}
                <p class="text-xs text-muted-foreground">{s.createdAt}</p>
              </div>
              <form
                method="post"
                action="?/revert"
                onsubmit={(e) => {
                  if (!confirm("Revert this module to that snapshot? A new snapshot is appended.")) {
                    e.preventDefault();
                  }
                }}
              >
                <input type="hidden" name="_csrf" value={data.csrfToken} />
                <input type="hidden" name="snapshotId" value={s.id} />
                <Button type="submit" variant="outline" size="sm">Revert this module to here</Button>
              </form>
            </CardContent>
          </Card>
        </li>
      {/each}
    </ul>
  {/if}
</div>
