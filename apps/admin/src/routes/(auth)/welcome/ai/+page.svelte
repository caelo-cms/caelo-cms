<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * First-run AI wizard: no key at all (the preselected option, #1460: the
   * install works through a connected agent), or pick a provider, paste a
   * key and land in the chat. Deliberately two fields — everything else
   * (models, output ceilings, env keys, local models) lives at
   * /settings/ai, linked below for the operators who need it.
   */

  import { MCP_ONLY_LEAVES_OFF } from "@caelo-cms/shared";

  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import AuthPlate from "#lib/components/AuthPlate.svelte";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Select } from "#lib/components/ui/select/index.js";
  import {
    MODEL_HELPER_TEXT,
    defaultModelForProvider,
    modelsForProvider,
  } from "#lib/ai-models.js";

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

  const MCP_ONLY = "mcp_only";
  const options = [
    {
      name: MCP_ONLY,
      label: "No AI key: use Caelo only through Power-MCP",
      hint: `Your own AI agent, such as Claude Code, builds the site. ${MCP_ONLY_LEAVES_OFF}`,
    },
    ...providers,
  ];

  let selected = $state<string>(form?.provider ?? MCP_ONLY);
  // null while the no-key option is selected: there is no key to ask for.
  const selectedProvider = $derived(providers.find((p) => p.name === selected) ?? null);

  // The model list + default follow the selected provider. Changing the
  // provider radio resets `model` to that provider's default.
  const models = $derived(selectedProvider ? modelsForProvider(selectedProvider.name) : []);
  let model = $state(defaultModelForProvider(providers.find((p) => p.name === form?.provider)?.name ?? "anthropic"));
</script>

<AuthPlate
  title="One last step"
  description="Caelo works through an AI. Bring your own agent with no key stored here, or pick the AI that powers your site and paste its API key."
>
  {#if form?.error}
    <Alert variant="destructive">
      <AlertDescription>{form.error}</AlertDescription>
    </Alert>
  {/if}
  <form method="post" class="space-y-4">
    <input type="hidden" name="_csrf" value={data.csrfToken} />
    <fieldset class="space-y-2">
      <legend class="text-sm font-medium">How Caelo gets its AI</legend>
      {#each options as p (p.name)}
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
              if (selectedProvider) model = defaultModelForProvider(selectedProvider.name);
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
    {#if selectedProvider}
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
      <div class="space-y-2">
        <Label for="model">Model</Label>
        <Select id="model" name="model" bind:value={model}>
          {#each models as m (m.id)}
            <option value={m.id}>{m.label}</option>
          {/each}
        </Select>
        <p class="text-xs text-muted-foreground">{MODEL_HELPER_TEXT}</p>
      </div>
    {/if}
    <Button type="submit" class="w-full">{selectedProvider ? "Save & start" : "Continue"}</Button>
  </form>
  <p class="text-center text-xs text-muted-foreground">
    Running a local model or using environment keys?
    <a href="/settings/ai" class="underline underline-offset-2">Advanced setup</a>
  </p>
</AuthPlate>
