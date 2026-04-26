<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  let { data, form } = $props();
  // svelte-check is happy with this minimal shape; the full type comes from
  // the @caelo/shared module schemas when we wire stricter inference later.
  const module = data.module as {
    id: string;
    slug: string;
    displayName: string;
    html: string;
    css: string;
    js: string;
    deletedAt: string | null;
  };
</script>

<nav>
  <a href="/content/modules">← Modules</a>
</nav>

<h1>Module: {module.slug}</h1>

{#if module.deletedAt}
  <p class="error">This module is soft-deleted ({module.deletedAt}).</p>
{/if}
{#if form?.error}
  <p class="error">{form.error}</p>
{/if}
{#if form?.ok}
  <p>Saved.</p>
{/if}

<form method="post" action="?/update">
  <input type="hidden" name="_csrf" value={data.csrfToken} />
  <label>
    Display name
    <input name="displayName" type="text" value={module.displayName} required />
  </label>
  <label>
    HTML
    <textarea name="html" rows="10">{module.html}</textarea>
  </label>
  <label>
    CSS
    <textarea name="css" rows="6">{module.css}</textarea>
  </label>
  <label>
    JS
    <textarea name="js" rows="6">{module.js}</textarea>
  </label>
  <button type="submit">Save</button>
</form>

{#if !module.deletedAt}
  <h2>Danger zone</h2>
  <form method="post" action="?/delete">
    <input type="hidden" name="_csrf" value={data.csrfToken} />
    <button type="submit">Soft-delete this module</button>
  </form>
{/if}
