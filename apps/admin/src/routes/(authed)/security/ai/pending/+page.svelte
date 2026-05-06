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

  function requiresApiKey(p: { kind: string; preview: Record<string, unknown> }): boolean {
    if (p.kind !== "set") return false;
    const r = p.preview.requiresSecrets;
    return Array.isArray(r) && r.includes("apiKey");
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Pending AI provider changes</h1>
    <p class="text-sm text-muted-foreground">
      AI-proposed AI provider config changes wait here. The AI never sends API key material —
      enter the provider key when you approve a <code>set</code> proposal that needs one
      (proposals editing an existing provider with a stored key can be approved without re-typing).
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
        No pending AI provider proposals.
      </CardContent>
    </Card>
  {:else}
    <div class="space-y-4">
      {#each data.proposals as p (p.id)}
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2 text-base">
              <Badge variant={p.kind === "clear_key" ? "destructive" : "secondary"}>
                {p.kind}
              </Badge>
              <Badge variant="outline">{p.providerName}</Badge>
              <span class="font-mono text-xs">{p.id.slice(0, 8)}…</span>
              <span class="ml-auto text-xs font-normal text-muted-foreground">
                proposed {new Date(p.createdAt).toISOString().slice(0, 19)}Z
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent class="space-y-3 text-sm">
            <details class="rounded border bg-muted/30 p-2" open>
              <summary class="cursor-pointer text-xs font-medium">Preview</summary>
              <pre class="mt-2 text-xs">{JSON.stringify(p.preview, null, 2)}</pre>
            </details>
            <form method="post" action="?/approve" class="space-y-2">
              <input type="hidden" name="_csrf" value={data.csrfToken} />
              <input type="hidden" name="proposalId" value={p.id} />
              {#if requiresApiKey(p)}
                <label class="block text-xs">
                  API key (required — no stored key for {p.providerName} yet)
                  <input
                    type="password"
                    name="apiKey"
                    required
                    autocomplete="off"
                    class="mt-1 block w-full rounded-md border bg-background p-1.5 text-xs"
                  />
                </label>
              {:else if p.kind === "set"}
                <label class="block text-xs">
                  API key (optional — leave blank to keep stored key)
                  <input
                    type="password"
                    name="apiKey"
                    autocomplete="off"
                    class="mt-1 block w-full rounded-md border bg-background p-1.5 text-xs"
                  />
                </label>
              {/if}
              <Button type="submit" variant={p.kind === "clear_key" ? "destructive" : "default"}>
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
          </CardContent>
        </Card>
      {/each}
    </div>
  {/if}
</div>
