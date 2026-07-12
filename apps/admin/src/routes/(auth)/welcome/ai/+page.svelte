<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * First-run AI wizard: pick a provider, paste a key, land in the
   * chat. Deliberately two fields — everything else (models, output
   * ceilings, env keys, local models) lives at /security/ai, linked
   * below for the operators who need it.
   */

  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
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

  const providers = [
    {
      name: "anthropic",
      label: "Anthropic (Claude)",
      hint: "Recommended — Caelo is built and tested against Claude.",
      keyPrefix: "sk-ant-…",
      keyUrl: "https://console.anthropic.com/settings/keys",
    },
    {
      name: "openai",
      label: "OpenAI",
      hint: "GPT models.",
      keyPrefix: "sk-…",
      keyUrl: "https://platform.openai.com/api-keys",
    },
    {
      name: "google",
      label: "Google (Gemini)",
      hint: "Gemini models.",
      keyPrefix: "AIza…",
      keyUrl: "https://aistudio.google.com/apikey",
    },
  ] as const;

  let selected = $state(form?.provider ?? "anthropic");
  const selectedProvider = $derived(providers.find((p) => p.name === selected) ?? providers[0]);
</script>

<Card>
  <CardHeader>
    <CardTitle>One last step</CardTitle>
    <CardDescription>
      Caelo works through an AI you talk to. Pick which AI powers your site and paste its API key —
      then you're in.
    </CardDescription>
  </CardHeader>
  <CardContent class="space-y-4">
    {#if form?.error}
      <Alert variant="destructive">
        <AlertDescription>{form.error}</AlertDescription>
      </Alert>
    {/if}
    <form method="post" class="space-y-4">
      <input type="hidden" name="_csrf" value={data.csrfToken} />
      <fieldset class="space-y-2">
        <legend class="text-sm font-medium">AI provider</legend>
        {#each providers as p (p.name)}
          <label
            class="flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors
              {selected === p.name ? 'border-primary bg-accent' : 'hover:bg-accent/50'}"
          >
            <input
              type="radio"
              name="provider"
              value={p.name}
              checked={selected === p.name}
              onchange={() => {
                selected = p.name;
              }}
              class="mt-1"
            />
            <span class="space-y-0.5">
              <span class="block text-sm font-medium">{p.label}</span>
              <span class="block text-xs text-muted-foreground">{p.hint}</span>
            </span>
          </label>
        {/each}
      </fieldset>
      <div class="space-y-2">
        <Label for="apiKey">API key</Label>
        <Input
          id="apiKey"
          name="apiKey"
          type="password"
          required
          autocomplete="off"
          placeholder={selectedProvider.keyPrefix}
        />
        <p class="text-xs text-muted-foreground">
          Get one at
          <a
            href={selectedProvider.keyUrl}
            target="_blank"
            rel="noreferrer"
            class="underline underline-offset-2">{new URL(selectedProvider.keyUrl).hostname}</a
          >. Stored encrypted, never shown again, switchable anytime.
        </p>
      </div>
      <Button type="submit" class="w-full">Save &amp; start</Button>
    </form>
    <p class="text-center text-xs text-muted-foreground">
      Running a local model or using environment keys?
      <a href="/security/ai" class="underline underline-offset-2">Advanced setup</a>
    </p>
  </CardContent>
</Card>
