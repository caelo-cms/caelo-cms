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

  function fmtUsd(mc: number | null): string {
    if (mc === null) return "—";
    return `$${(mc / 1e8).toFixed(2)}`;
  }
  function statusVariant(s: string): "success" | "warning" | "destructive" | "outline" {
    if (s === "ok") return "success";
    if (s === "warn") return "warning";
    if (s === "blocked") return "destructive";
    return "outline";
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">AI budgets</h1>
    <p class="text-sm text-muted-foreground">
      Caps in microcents (USD × 10⁸). Three scopes (session / day-global / day-per-actor) × two
      operation types (text / image) = six independent caps. Text and image enforce independently —
      exhausting the image cap never blocks text generation in the same session.
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

  <div class="grid gap-4 md:grid-cols-2">
    {#each data.matrix as row}
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2 text-base">
            {row.scope} · {row.operationType}
            <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
          </CardTitle>
          <CardDescription>
            Spent (last 24h): {fmtUsd(row.spentMicrocents)}{#if row.pct !== null}
              · {(row.pct * 100).toFixed(0)}%{/if}
            of {fmtUsd(row.capMicrocents)}
            {#if row.scope === "session"}
              <span class="text-muted-foreground"
                >· session-scope spend tracked on chat_sessions, not visible here</span
              >
            {/if}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form method="post" action="?/set" class="space-y-3">
            <input type="hidden" name="_csrf" value={data.csrfToken} />
            <input type="hidden" name="scope" value={row.scope} />
            <input type="hidden" name="operationType" value={row.operationType} />
            <div class="grid gap-3 md:grid-cols-2">
              <div class="space-y-2">
                <Label for="cap-{row.scope}-{row.operationType}">Cap (microcents)</Label>
                <Input
                  id="cap-{row.scope}-{row.operationType}"
                  name="capMicrocents"
                  type="number"
                  min="0"
                  value={row.capMicrocents ?? ""}
                  placeholder="leave blank for unlimited"
                />
              </div>
              <div class="space-y-2">
                <Label for="warn-{row.scope}-{row.operationType}">Warn at (0.0–1.0)</Label>
                <Input
                  id="warn-{row.scope}-{row.operationType}"
                  name="warnAtPct"
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  value={row.warnAtPct}
                />
              </div>
            </div>
            <Button type="submit">Save</Button>
          </form>
        </CardContent>
      </Card>
    {/each}
  </div>
</div>
