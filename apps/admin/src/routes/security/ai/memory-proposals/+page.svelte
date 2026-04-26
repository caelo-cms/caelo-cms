<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  let { data, form } = $props();
</script>

<nav>
  <a href="/security/ai">← AI provider</a>
</nav>

<h1>Memory proposals</h1>

<p>
  Pending memory additions the AI proposed mid-conversation. Accepted
  proposals replace the matching slot's body; rejected proposals remain in
  the queue with status set to <code>rejected</code>.
</p>

{#if form?.error}<p class="error">{form.error}</p>{/if}
{#if form?.ok}<p>Decision recorded.</p>{/if}

{#if data.proposals.length === 0}
  <p><em>No pending proposals.</em></p>
{:else}
  <ul>
    {#each data.proposals as p (p.id)}
      <li style="margin-bottom: 1rem">
        <strong>{p.slot}</strong> — proposed {p.createdAt}
        <pre style="background: #f7f7f7; padding: 0.5rem">{p.body}</pre>
        <em>Rationale:</em> {p.rationale}
        <br />
        <form method="post" action="?/review" style="display: inline">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <input type="hidden" name="proposalId" value={p.id} />
          <input type="hidden" name="decision" value="accept" />
          <button type="submit">Accept</button>
        </form>
        <form method="post" action="?/review" style="display: inline">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <input type="hidden" name="proposalId" value={p.id} />
          <input type="hidden" name="decision" value="reject" />
          <button type="submit">Reject</button>
        </form>
      </li>
    {/each}
  </ul>
{/if}
