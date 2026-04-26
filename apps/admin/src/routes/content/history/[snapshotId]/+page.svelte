<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  let { data, form } = $props();
</script>

<nav>
  <a href="/content/history">← History</a>
</nav>

<h1>Snapshot {data.snapshot.id.slice(0, 8)}</h1>

<p>
  <strong>{data.snapshot.description}</strong><br />
  <small>{data.snapshot.createdAt}</small>
  {#if data.snapshot.revertOf}
    <br /><em>Revert of snapshot {data.snapshot.revertOf.slice(0, 8)}</em>
  {/if}
</p>

{#if form?.error}
  <p class="error">{form.error}</p>
{/if}
{#if form?.ok}
  <p>{form.ok}</p>
{/if}

{#if data.modules.length > 0}
  <h2>Modules ({data.modules.length})</h2>
  <ul>
    {#each data.modules as m (m.entityId)}
      <li>
        <strong>{m.state.slug}</strong> — {m.state.displayName}
        <form method="post" action="?/revertModule" style="display: inline">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <input type="hidden" name="moduleId" value={m.entityId} />
          <button type="submit">Revert this module</button>
        </form>
      </li>
    {/each}
  </ul>
{/if}

{#if data.templates.length > 0}
  <h2>Templates ({data.templates.length})</h2>
  <ul>
    {#each data.templates as t (t.entityId)}
      <li>
        <strong>{t.state.slug}</strong> — {t.state.displayName}
        <form method="post" action="?/revertTemplate" style="display: inline">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <input type="hidden" name="templateId" value={t.entityId} />
          <button type="submit">Revert this template</button>
        </form>
      </li>
    {/each}
  </ul>
{/if}

{#if data.pages.length > 0}
  <h2>Pages ({data.pages.length})</h2>
  <ul>
    {#each data.pages as p (p.entityId)}
      <li>
        <strong>{p.state.slug}</strong> ({p.state.locale}) — {p.state.title}
        <form method="post" action="?/revertPage" style="display: inline">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <input type="hidden" name="pageId" value={p.entityId} />
          <button type="submit">Revert this page (metadata)</button>
        </form>
      </li>
    {/each}
  </ul>
{/if}

{#if data.pageLayouts.length > 0}
  <h2>Page layouts ({data.pageLayouts.length})</h2>
  <ul>
    {#each data.pageLayouts as l (l.entityId)}
      <li>
        Layout for page {l.entityId.slice(0, 8)}
        <form method="post" action="?/revertPage" style="display: inline">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <input type="hidden" name="pageId" value={l.entityId} />
          <button type="submit">Restore this layout</button>
        </form>
      </li>
    {/each}
  </ul>
{/if}

<h2>Or revert everything in this snapshot</h2>
<form
  method="post"
  action="?/revertSite"
  onsubmit={(e) => {
    if (!confirm("Revert the entire site to this snapshot? A new snapshot will be appended.")) {
      e.preventDefault();
    }
  }}
>
  <input type="hidden" name="_csrf" value={data.csrfToken} />
  <button type="submit">Revert site to this snapshot</button>
</form>
