<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  let { data, form } = $props();
</script>

<nav>
  <a href="/content">← Content</a>
</nav>

<h1>Chats</h1>

{#if form?.error}<p class="error">{form.error}</p>{/if}

<form method="post" action="?/create">
  <input type="hidden" name="_csrf" value={data.csrfToken} />
  <button type="submit">+ New chat</button>
</form>

<h2>Your chats</h2>
{#if data.sessions.length === 0}
  <p><em>No chats yet.</em></p>
{:else}
  <ul>
    {#each data.sessions as s (s.id)}
      <li>
        <a href={`/content/chat/${s.id}`}>{s.title}</a>
        <small>last active {s.lastActiveAt.slice(0, 16)}</small>
        {#if s.publishedAt}
          <em>published</em>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
