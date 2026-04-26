<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  let { data, form } = $props();
</script>

<nav>
  <a href="/content">← Content</a>
</nav>

<h1>Pages</h1>

{#if form?.error}
  <p class="error">{form.error}</p>
{/if}

<h2>Existing pages</h2>
{#if data.pages.length === 0}
  <p><em>No pages yet.</em></p>
{:else}
  <ul>
    {#each data.pages as p (p.id)}
      <li>
        <a href={`/content/pages/${p.id}`}><strong>{p.slug}</strong></a>
        ({p.locale}) — {p.title}
        <small>[{p.status}] updated {p.updatedAt.slice(0, 10)}</small>
      </li>
    {/each}
  </ul>
{/if}

<h2>New page</h2>
{#if data.templates.length === 0}
  <p>
    <em>Create a <a href="/content/templates">template</a> first — pages must reference one.</em>
  </p>
{:else}
  <form method="post" action="?/create">
    <input type="hidden" name="_csrf" value={data.csrfToken} />
    <label>
      Slug
      <input name="slug" type="text" pattern="[a-z0-9](?:[a-z0-9-]{'{0,62}'}[a-z0-9])?" required />
    </label>
    <label>
      Locale
      <input name="locale" type="text" value="en" pattern="[a-z]{'{2}'}(-[A-Z]{'{2}'})?" required />
    </label>
    <label>
      Title
      <input name="title" type="text" required />
    </label>
    <label>
      Template
      <select name="templateId" required>
        {#each data.templates as t (t.id)}
          <option value={t.id}>{t.slug} — {t.displayName}</option>
        {/each}
      </select>
    </label>
    <button type="submit">Create</button>
  </form>
{/if}
