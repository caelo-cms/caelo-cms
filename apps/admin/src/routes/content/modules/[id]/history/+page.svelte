<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  let { data, form } = $props();
</script>

<nav>
  <a href={`/content/modules/${data.moduleId}`}>← Module</a>
</nav>

<h1>History — {data.module?.slug ?? data.moduleId.slice(0, 8)}</h1>

<p>
  Every snapshot that touched this module, reverse-chronological. Reverting jumps
  the live module back to the captured state and appends a new snapshot to the
  global history.
</p>

{#if form?.error}
  <p class="error">{form.error}</p>
{/if}

{#if data.snapshots.length === 0}
  <p><em>No snapshots for this module yet.</em></p>
{:else}
  <ul>
    {#each data.snapshots as s (s.id)}
      <li style="margin-bottom: 0.5rem">
        <strong>{s.description}</strong>
        {#if s.revertOf}
          <em>(revert of {s.revertOf.slice(0, 8)})</em>
        {/if}
        <br />
        <small>{s.createdAt}</small>
        <form
          method="post"
          action="?/revert"
          style="display: inline"
          onsubmit={(e) => {
            if (!confirm("Revert this module to that snapshot? A new snapshot is appended.")) {
              e.preventDefault();
            }
          }}
        >
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <input type="hidden" name="snapshotId" value={s.id} />
          <button type="submit">Revert this module to here</button>
        </form>
      </li>
    {/each}
  </ul>
{/if}
