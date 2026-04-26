<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  let { data, form } = $props();
</script>

<nav>
  <a href="/content">← Content</a>
</nav>

<h1>Templates</h1>

{#if form?.error}
  <p class="error">{form.error}</p>
{/if}

<h2>Existing templates</h2>
{#if data.templates.length === 0}
  <p><em>No templates yet.</em></p>
{:else}
  <ul>
    {#each data.templates as t (t.id)}
      <li>
        <a href={`/content/templates/${t.id}`}><strong>{t.slug}</strong></a> — {t.displayName}
        <small>updated {t.updatedAt.slice(0, 10)}</small>
      </li>
    {/each}
  </ul>
{/if}

<h2>New template</h2>
<form method="post" action="?/create">
  <input type="hidden" name="_csrf" value={data.csrfToken} />
  <label>
    Slug
    <input name="slug" type="text" pattern="[a-z0-9](?:[a-z0-9-]{'{0,62}'}[a-z0-9])?" required />
  </label>
  <label>
    Display name
    <input name="displayName" type="text" required />
  </label>
  <label>
    HTML (use <code>&lt;caelo-slot name="…"&gt;</code> markers for blocks)
    <textarea name="html" rows="10" required></textarea>
  </label>
  <button type="submit">Create</button>
</form>
