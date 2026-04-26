<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  let { data, form } = $props();
  const template = data.template as {
    id: string;
    slug: string;
    displayName: string;
    html: string;
    css: string;
    deletedAt: string | null;
    blocks: { name: string; displayName: string; position: number }[];
  };
  // Local mutable copy of the blocks list, with one trailing blank row so the
  // user can append. Saved as a single atomic replace via template_blocks.set.
  let blocks = $state(
    template.blocks.length > 0
      ? template.blocks.map((b) => ({ name: b.name, displayName: b.displayName }))
      : [{ name: "content", displayName: "Content" }],
  );
  function addBlock(): void {
    blocks = [...blocks, { name: "", displayName: "" }];
  }
  function removeBlock(i: number): void {
    blocks = blocks.filter((_, idx) => idx !== i);
  }
</script>

<nav>
  <a href="/content/templates">← Templates</a>
</nav>

<h1>Template: {template.slug}</h1>

{#if template.deletedAt}
  <p class="error">This template is soft-deleted ({template.deletedAt}).</p>
{/if}
{#if form?.error}
  <p class="error">{form.error}</p>
{/if}
{#if form?.ok}
  <p>Saved.</p>
{/if}

<h2>Skeleton</h2>
<form method="post" action="?/update">
  <input type="hidden" name="_csrf" value={data.csrfToken} />
  <label>
    Display name
    <input name="displayName" type="text" value={template.displayName} required />
  </label>
  <label>
    HTML
    <textarea name="html" rows="14">{template.html}</textarea>
  </label>
  <label>
    CSS
    <textarea name="css" rows="6">{template.css}</textarea>
  </label>
  <button type="submit">Save skeleton</button>
</form>

<h2>Blocks (slot inventory)</h2>
<p>
  Each row matches a <code>&lt;caelo-slot name="…"&gt;</code> in the HTML above.
  Saving replaces the entire block list atomically.
</p>
<form method="post" action="?/setBlocks">
  <input type="hidden" name="_csrf" value={data.csrfToken} />
  {#each blocks as block, i (i)}
    <div style="display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.25rem">
      <input
        name={`blockName.${i}`}
        type="text"
        placeholder="slot name (e.g. content)"
        bind:value={block.name}
        pattern="[a-z0-9](?:[a-z0-9-]{'{0,62}'}[a-z0-9])?"
      />
      <input
        name={`blockDisplay.${i}`}
        type="text"
        placeholder="display name"
        bind:value={block.displayName}
      />
      <button type="button" onclick={() => removeBlock(i)}>×</button>
    </div>
  {/each}
  <button type="button" onclick={addBlock}>+ Add block</button>
  <button type="submit">Save blocks</button>
</form>

{#if !template.deletedAt}
  <h2>Danger zone</h2>
  <form method="post" action="?/delete">
    <input type="hidden" name="_csrf" value={data.csrfToken} />
    <button type="submit">Soft-delete this template</button>
  </form>
{/if}
