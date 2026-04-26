<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
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

<nav>
  <a href="/security">← Security</a>
</nav>

<h1>AI provider</h1>

<p>
  Configure the active AI provider for the editor chat. The API key lives in
  the secrets manager / <code>ANTHROPIC_API_KEY</code> env var, never in the
  database. Provider name and brand are visible only on this page and the cost
  dashboard — editors see only "AI" in the chat surface.
</p>

{#if form?.error}
  <p class="error">{form.error}</p>
{/if}
{#if form?.ok}
  <p>Saved.</p>
{/if}

<h2>Anthropic</h2>
<p>
  API key: {data.apiKeySet
    ? "set"
    : "not set — the chat surface will fail to stream until ANTHROPIC_API_KEY is provided"}
</p>
<form method="post" action="?/set">
  <input type="hidden" name="_csrf" value={data.csrfToken} />
  <label>
    Model
    <input name="model" type="text" value={currentModel} required />
  </label>
  <button type="submit">Save</button>
</form>

<h2>Other providers</h2>
<p><em>OpenAI, Google, and local OpenAI-compatible adapters land in P16.</em></p>

<h2>Site AI memory</h2>
<p>
  <a href="/security/ai/memory">Site AI memory</a> — Owner-curated brand voice,
  tone, banned phrases, and recurring instructions that prepend every chat.
</p>
<p>
  <a href="/security/ai/memory-proposals">Memory proposals</a> — review queue
  for AI-suggested memory additions. Nothing auto-applies.
</p>
