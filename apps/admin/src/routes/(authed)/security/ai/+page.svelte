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
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">AI providers</h1>
    <p class="text-sm text-muted-foreground">
      Configure providers + active model. API keys live in the secrets manager / env, never in the
      database. Exactly one provider is active at a time. Provider brand is visible only here and on
      the cost dashboard.
    </p>
    <div class="mt-3 flex flex-wrap gap-2 text-sm">
      <a class="underline" href="/security/ai/pricing">Pricing rates →</a>
      <a class="underline" href="/security/ai/budgets">Budgets →</a>
      <a class="underline" href="/security/ai/telemetry">Telemetry →</a>
      <a class="underline" href="/security/costs">Cost dashboard →</a>
    </div>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>Saved {form.providerName ?? ""}.</AlertDescription></Alert>
  {/if}

  {#each data.providers as p}
    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2 text-base">
          {p.displayName}
          {#if p.isActive}
            <Badge variant="success">Active</Badge>
          {/if}
          <Badge variant={p.apiKeySet ? "success" : "destructive"}>
            {p.apiKeySet ? "Key set" : "Key missing"}
          </Badge>
        </CardTitle>
        <CardDescription>
          {#if p.keyEnv}Reads <code>{p.keyEnv}</code> from env at runtime.{/if}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" action="?/set" class="grid gap-4 md:grid-cols-3">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <input type="hidden" name="name" value={p.name} />
          <div class="space-y-2">
            <Label for="model-{p.name}">Model</Label>
            <Input id="model-{p.name}" name="model" type="text" value={p.model} required />
          </div>
          {#if p.name === "local-openai-compat"}
            <div class="space-y-2">
              <Label for="baseUrl-{p.name}">Base URL</Label>
              <Input
                id="baseUrl-{p.name}"
                name="baseUrl"
                type="text"
                value={p.baseUrl ?? ""}
                placeholder="http://localhost:11434/v1"
              />
            </div>
          {/if}
          <div class="flex items-end gap-2">
            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="isActive"
                value="1"
                checked={p.isActive}
                disabled={!p.apiKeySet}
              />
              Activate
            </label>
            <Button type="submit">Save</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  {/each}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Site AI memory</CardTitle>
    </CardHeader>
    <CardContent class="space-y-1 text-sm">
      <p>
        <a class="underline" href="/security/ai/memory">Site AI memory</a> — Owner-curated brand
        voice, tone, banned phrases, and recurring instructions.
      </p>
      <p>
        <a class="underline" href="/security/ai/memory-proposals">Memory proposals</a> — review
        queue for AI-suggested memory additions. Nothing auto-applies.
      </p>
    </CardContent>
  </Card>
</div>
