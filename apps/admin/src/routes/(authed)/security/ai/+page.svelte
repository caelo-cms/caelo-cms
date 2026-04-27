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
  const provider = data.providers.find(
    (p: { name: string }) => p.name === "anthropic",
  ) as
    | {
        name: string;
        displayName: string;
        config: Record<string, unknown>;
        isActive: boolean;
      }
    | undefined;
  const currentModel =
    (provider?.config && typeof provider.config["model"] === "string"
      ? (provider.config["model"] as string)
      : null) ?? "claude-opus-4-7";
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">AI provider</h1>
    <p class="text-sm text-muted-foreground">
      Configure the active provider. API keys live in the secrets manager / env, never in the
      database. Provider brand is visible only here and on the cost dashboard.
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>Saved.</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="flex items-center gap-2 text-base">
        Anthropic
        <Badge variant={data.apiKeySet ? "success" : "destructive"}>
          {data.apiKeySet ? "API key set" : "API key missing"}
        </Badge>
      </CardTitle>
      <CardDescription>
        Reads <code>ANTHROPIC_API_KEY</code> from the env at runtime.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/set" class="space-y-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <div class="space-y-2">
          <Label for="model">Model</Label>
          <Input id="model" name="model" type="text" value={currentModel} required />
        </div>
        <Button type="submit">Save</Button>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Other providers</CardTitle>
      <CardDescription>OpenAI, Google, and local OpenAI-compatible adapters land in P16.</CardDescription>
    </CardHeader>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Site AI memory</CardTitle>
    </CardHeader>
    <CardContent class="space-y-1 text-sm">
      <p>
        <a class="underline" href="/security/ai/memory">Site AI memory</a> —
        Owner-curated brand voice, tone, banned phrases, and recurring instructions.
      </p>
      <p>
        <a class="underline" href="/security/ai/memory-proposals">Memory proposals</a> —
        review queue for AI-suggested memory additions. Nothing auto-applies.
      </p>
    </CardContent>
  </Card>
</div>
