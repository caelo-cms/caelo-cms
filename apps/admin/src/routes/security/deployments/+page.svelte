<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  let { data } = $props();
</script>

<nav>
  <a href="/security">← Security</a>
</nav>

<h1>Deployments</h1>

<p>
  Three-environment model. Editors only see "Publish" on each page (which
  ships to the default target). Ops users land here to drive the real
  Draft → Staging → Production flow.
</p>

<h2>Targets</h2>
<ul>
  {#each data.targets as t (t.id)}
    <li>
      <strong>{t.name}</strong>
      <code>{t.env}</code>
      <small>out_dir={t.outDir} robots={t.robotsDefault}{t.isDefault ? " (default)" : ""}</small>
      <form method="post" action="?/trigger" style="display:inline">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <input type="hidden" name="targetName" value={t.name} />
        <button type="submit">Build {t.name}</button>
      </form>
    </li>
  {/each}
</ul>

<h2>Promote</h2>
<form method="post" action="?/promote">
  <input type="hidden" name="_csrf" value={data.csrfToken} />
  <label>
    From
    <select name="fromTarget">
      {#each data.targets as t (t.id)}
        <option value={t.name}>{t.name}</option>
      {/each}
    </select>
  </label>
  <label>
    To
    <select name="toTarget">
      {#each data.targets as t (t.id)}
        <option value={t.name}>{t.name}</option>
      {/each}
    </select>
  </label>
  <button type="submit">Promote</button>
</form>

<h2>Recent runs</h2>
{#if data.runs.length === 0}
  <p><em>No deploy runs yet.</em></p>
{:else}
  <ul>
    {#each data.runs as r (r.id)}
      <li>
        <strong>{r.targetName}</strong>
        <code>{r.env}</code>
        — {r.status}
        — started {r.startedAt.slice(0, 19).replace("T", " ")}
        {#if r.pageCount !== null}
          — {r.pageCount} page(s), {r.fileCount} file(s)
        {/if}
        {#if r.errorMessage}
          <pre>{r.errorMessage}</pre>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
