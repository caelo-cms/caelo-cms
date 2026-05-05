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
      Configure providers + active model. API keys are encrypted at rest with the project KEK before
      hitting the database, never logged, never returned to the browser. Exactly one provider is
      active at a time. Provider brand is visible only here and on the cost dashboard.
    </p>
    <div class="mt-3 flex flex-wrap gap-2 text-sm">
      <a class="underline" href="/security/ai/pricing">Pricing rates →</a>
      <a class="underline" href="/security/ai/budgets">Budgets →</a>
      <a class="underline" href="/security/ai/telemetry">Telemetry →</a>
      <a class="underline" href="/security/costs">Cost dashboard →</a>
    </div>
  </div>

  {#if data.firstRun}
    <Alert>
      <AlertDescription>
        <strong>One more step:</strong> configure your first AI provider to enable chat,
        translation, and AI tools. Pick a provider below, paste an API key, and click Save. You can
        switch providers anytime from this page.
      </AlertDescription>
    </Alert>
  {/if}

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok && form?.cleared}
    <Alert
      ><AlertDescription
        >Cleared stored API key for {form.providerName ?? ""} — provider falls back to the env-var
        path (or "not configured" if no env is set).</AlertDescription
      ></Alert
    >
  {:else if form?.ok}
    <Alert
      ><AlertDescription
        >Saved {form.providerName ?? ""}{form.apiKeyChanged
          ? " (API key updated)"
          : ""}.</AlertDescription
      ></Alert
    >
  {/if}

  {#each data.providers as p}
    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2 text-base">
          {p.displayName}
          {#if p.isActive}
            <Badge variant="success">Active</Badge>
          {/if}
          {#if p.apiKeySource === "db"}
            <Badge variant="success">Source: DB ✓</Badge>
          {:else if p.apiKeySource === "env"}
            <Badge variant="success">Source: env (fallback) ✓</Badge>
          {:else}
            <Badge variant="destructive">Not configured</Badge>
          {/if}
        </CardTitle>
        <CardDescription>
          {#if p.apiKeySource === "db" && p.apiKeySetAt}
            Encrypted key set {new Date(p.apiKeySetAt).toLocaleString()}.
          {:else if p.apiKeySource === "env"}
            Reads the legacy environment variable. Save a key below to migrate to the encrypted DB
            path.
          {:else}
            Paste an API key below to configure this provider.
          {/if}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" action="?/set" class="grid gap-4 md:grid-cols-2">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <input type="hidden" name="name" value={p.name} />
          <div class="space-y-2 md:col-span-2">
            <Label for="apiKey-{p.name}">
              API key
              {#if p.apiKeySource === "db"}<span class="text-xs text-muted-foreground"
                  >(leave blank to keep current key)</span
                >{/if}
            </Label>
            <Input
              id="apiKey-{p.name}"
              name="apiKey"
              type="password"
              autocomplete="off"
              placeholder={p.name === "anthropic"
                ? "sk-ant-…"
                : p.name === "openai"
                  ? "sk-…"
                  : "API key"}
            />
          </div>
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
          <div class="md:col-span-2 flex items-center justify-between gap-4">
            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="isActive"
                value="1"
                checked={p.isActive}
                disabled={p.apiKeySource === null}
              />
              Activate (only one provider can be active at a time)
            </label>
            <Button type="submit">Save</Button>
          </div>
        </form>
        {#if p.apiKeySource === "db"}
          <form method="post" action="?/clear_key" class="mt-3">
            <input type="hidden" name="_csrf" value={data.csrfToken} />
            <input type="hidden" name="name" value={p.name} />
            <Button type="submit" variant="outline" size="sm">Clear stored key</Button>
          </form>
        {/if}
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
