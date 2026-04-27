<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";

  let { data, form } = $props();
  function bodyFor(slot: string): string {
    const m = data.memory.find((x: { slot: string }) => x.slot === slot);
    return m?.body ?? "";
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Site AI memory</h1>
    <p class="text-sm text-muted-foreground">
      Owner-curated context prepended to every AI system prompt. Saving an empty body clears the slot.
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>Saved.</AlertDescription></Alert>
  {/if}

  {#each data.slots as slot (slot)}
    <Card>
      <CardHeader>
        <CardTitle class="text-base">{slot}</CardTitle>
      </CardHeader>
      <CardContent>
        <form method="post" action="?/set" class="space-y-2">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <input type="hidden" name="slot" value={slot} />
          <Textarea name="body" rows={4} placeholder="(empty)" value={bodyFor(slot)} />
          <Button type="submit">Save {slot}</Button>
        </form>
      </CardContent>
    </Card>
  {/each}
</div>
