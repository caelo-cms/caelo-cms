<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  let { data, form } = $props();
  function bodyFor(slot: string): string {
    const m = data.memory.find((x: { slot: string }) => x.slot === slot);
    return m?.body ?? "";
  }
</script>

<nav>
  <a href="/security/ai">← AI provider</a>
</nav>

<h1>Site AI memory</h1>

<p>
  Owner-curated context that prepends every AI system prompt. One body per
  slot; saving an empty body clears the slot.
</p>

{#if form?.error}<p class="error">{form.error}</p>{/if}
{#if form?.ok}<p>Saved.</p>{/if}

{#each data.slots as slot (slot)}
  <h2>{slot}</h2>
  <form method="post" action="?/set">
    <input type="hidden" name="_csrf" value={data.csrfToken} />
    <input type="hidden" name="slot" value={slot} />
    <textarea name="body" rows="4" cols="80" placeholder={`(empty)`}>{bodyFor(slot)}</textarea>
    <br />
    <button type="submit">Save {slot}</button>
  </form>
{/each}
