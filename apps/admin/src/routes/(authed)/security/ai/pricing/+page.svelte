<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";

  let { data, form } = $props();

  // Microcents = USD * 1e8. For text rates the column is the per-1K-token
  // price; for image it's the per-image price. The cost dashboard divides
  // back to USD when displaying.
  function fmtPer1k(mc: number | null): string {
    if (mc === null) return "—";
    return `$${(mc / 1e8).toFixed(4)} / 1K`;
  }
  function fmtPerImage(mc: number): string {
    return `$${(mc / 1e8).toFixed(4)} / image`;
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">AI pricing</h1>
    <p class="text-sm text-muted-foreground">
      Per-model rates in microcents (USD × 10⁸). recordAiCall reads the latest effective row at call
      time, so a rate change here flows without a redeploy. Historical rows are preserved.
    </p>
    <div class="mt-3 text-sm">
      <a class="underline" href="/security/ai">← AI providers</a>
    </div>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>Saved {form.key}.</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Effective rates</CardTitle>
      <CardDescription>
        Latest row per (provider, model, operation type). Falls back to model = <code>*</code>
         when no exact-model row exists.
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.rows.length === 0}
        <p class="text-sm text-muted-foreground">No pricing rows yet.</p>
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b text-left">
                <th class="py-2 pr-4">Provider</th>
                <th class="py-2 pr-4">Model</th>
                <th class="py-2 pr-4">Type</th>
                <th class="py-2 pr-4">Input</th>
                <th class="py-2 pr-4">Cached</th>
                <th class="py-2 pr-4">Output</th>
                <th class="py-2 pr-4">Effective from</th>
              </tr>
            </thead>
            <tbody>
              {#each data.rows as r}
                <tr class="border-b">
                  <td class="py-2 pr-4">{r.provider}</td>
                  <td class="py-2 pr-4 font-mono text-xs">{r.model}</td>
                  <td class="py-2 pr-4"><Badge variant="outline">{r.operationType}</Badge></td>
                  <td class="py-2 pr-4">
                    {r.operationType === "image"
                      ? fmtPerImage(r.inputMicrocents)
                      : fmtPer1k(r.inputMicrocents)}
                  </td>
                  <td class="py-2 pr-4">
                    {r.operationType === "image" ? "—" : fmtPer1k(r.cachedMicrocents)}
                  </td>
                  <td class="py-2 pr-4">
                    {r.operationType === "image" ? "—" : fmtPer1k(r.outputMicrocents)}
                  </td>
                  <td class="py-2 pr-4 text-xs text-muted-foreground">
                    {new Date(r.effectiveFrom).toISOString().slice(0, 10)}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Add or update a rate</CardTitle>
      <CardDescription>
        New rows take effect immediately. Use model = <code>*</code> as a provider-wide fallback
        (handy for self-hosted local models where the model name varies per deployment).
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/set" class="grid gap-4 md:grid-cols-3">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <div class="space-y-2">
          <Label for="provider">Provider</Label>
          <Input id="provider" name="provider" type="text" required placeholder="anthropic" />
        </div>
        <div class="space-y-2">
          <Label for="model">Model</Label>
          <Input id="model" name="model" type="text" required placeholder="claude-sonnet-5" />
        </div>
        <div class="space-y-2">
          <Label for="operationType">Operation type</Label>
          <select
            id="operationType"
            name="operationType"
            class="border-input focus-visible:ring-ring h-9 w-full rounded-md border bg-transparent px-3 text-sm"
          >
            <option value="text">text</option>
            <option value="image">image</option>
          </select>
        </div>
        <div class="space-y-2">
          <Label for="inputMicrocents">Input microcents</Label>
          <Input id="inputMicrocents" name="inputMicrocents" type="number" min="0" required />
        </div>
        <div class="space-y-2">
          <Label for="outputMicrocents">Output microcents (text only)</Label>
          <Input id="outputMicrocents" name="outputMicrocents" type="number" min="0" />
        </div>
        <div class="space-y-2">
          <Label for="cachedMicrocents">Cached microcents (text only)</Label>
          <Input id="cachedMicrocents" name="cachedMicrocents" type="number" min="0" />
        </div>
        <div class="md:col-span-3">
          <Button type="submit">Save</Button>
        </div>
      </form>
    </CardContent>
  </Card>
</div>
