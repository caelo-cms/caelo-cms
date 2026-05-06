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

  function transportOf(p: { preview: Record<string, unknown> }) {
    return String(p.preview.transport ?? "?");
  }
  function requiredSecrets(p: { preview: Record<string, unknown> }): string[] {
    const v = p.preview.requiresSecrets;
    return Array.isArray(v) ? v.map(String) : [];
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Pending email config</h1>
    <p class="text-sm text-muted-foreground">
      AI-proposed email transport changes wait here. The AI never sends credential material —
      enter the transport secret (SMTP password, Resend API key, or SES keys) when you approve. The
      key only enters this server at click time and is never stored in the proposal.
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
        No pending email config proposals.
      </CardContent>
    </Card>
  {:else}
    <div class="space-y-4">
      {#each data.proposals as p (p.id)}
        {@const tx = transportOf(p)}
        {@const needs = requiredSecrets(p)}
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2 text-base">
              <Badge variant="secondary">transport: {tx}</Badge>
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
              {#if needs.includes("smtpPassword")}
                <label class="block text-xs">
                  SMTP password
                  <input
                    type="password"
                    name="smtpPassword"
                    required
                    autocomplete="off"
                    class="mt-1 block w-full rounded-md border bg-background p-1.5 text-xs"
                  />
                </label>
              {/if}
              {#if needs.includes("resendApiKey")}
                <label class="block text-xs">
                  Resend API key
                  <input
                    type="password"
                    name="resendApiKey"
                    required
                    autocomplete="off"
                    class="mt-1 block w-full rounded-md border bg-background p-1.5 text-xs"
                  />
                </label>
              {/if}
              {#if needs.includes("sesAccessKeyId")}
                <label class="block text-xs">
                  SES access key ID
                  <input
                    type="text"
                    name="sesAccessKeyId"
                    required
                    autocomplete="off"
                    class="mt-1 block w-full rounded-md border bg-background p-1.5 text-xs"
                  />
                </label>
              {/if}
              {#if needs.includes("sesSecretAccessKey")}
                <label class="block text-xs">
                  SES secret access key
                  <input
                    type="password"
                    name="sesSecretAccessKey"
                    required
                    autocomplete="off"
                    class="mt-1 block w-full rounded-md border bg-background p-1.5 text-xs"
                  />
                </label>
              {/if}
              <Button type="submit">Approve</Button>
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
