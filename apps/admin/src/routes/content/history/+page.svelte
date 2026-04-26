<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  let { data, form } = $props();
</script>

<nav>
  <a href="/content">← Content</a>
</nav>

<h1>Advanced history</h1>

<p>
  Reverse-chronological list of every site snapshot. Each entry groups the
  affected modules, templates, pages, and page-layout changes from one atomic
  write. Reverting a snapshot is appended to the timeline (linear history,
  never destructive).
</p>

{#if form?.error}
  <p class="error">{form.error}</p>
{/if}

{#if data.snapshots.length === 0}
  <p><em>No snapshots yet.</em></p>
{:else}
  <ul>
    {#each data.snapshots as s (s.id)}
      <li style="margin-bottom: 0.75rem">
        <strong>{s.description}</strong>
        {#if s.revertOf}
          <em>(revert of {s.revertOf.slice(0, 8)})</em>
        {/if}
        <br />
        <small>
          {s.createdAt} —
          modules:{s.moduleCount}, templates:{s.templateCount}, pages:{s.pageCount},
          layouts:{s.pageLayoutCount}
        </small>
        <br />
        <a href={`/content/history/${s.id}`}>View entities</a>
        {#if s.moduleCount + s.templateCount + s.pageCount + s.pageLayoutCount > 0}
          <form
            method="post"
            action="?/revertSite"
            style="display: inline"
            onsubmit={(e) => {
              if (!confirm("Revert the entire site to this snapshot? A new snapshot will be appended to the history.")) {
                e.preventDefault();
              }
            }}
          >
            <input type="hidden" name="_csrf" value={data.csrfToken} />
            <input type="hidden" name="snapshotId" value={s.id} />
            <button type="submit">Revert site to here</button>
          </form>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
