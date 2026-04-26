<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  let { data, form } = $props();
</script>

<nav>
  <a href="/content">← Content</a>
</nav>

<h1>Modules</h1>

{#if form?.error}
  <p class="error">{form.error}</p>
{/if}

<h2>Existing modules</h2>
{#if data.modules.length === 0}
  <p><em>No modules yet.</em></p>
{:else}
  <ul>
    {#each data.modules as m (m.id)}
      <li>
        <a href={`/content/modules/${m.id}`}><strong>{m.slug}</strong></a> — {m.displayName}
        <small>updated {m.updatedAt.slice(0, 10)}</small>
      </li>
    {/each}
  </ul>
{/if}

<h2>New module</h2>
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
    HTML
    <textarea name="html" rows="6" required></textarea>
  </label>
  <button type="submit">Create</button>
</form>
