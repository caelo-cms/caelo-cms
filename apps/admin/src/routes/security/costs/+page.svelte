<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  let { data } = $props();
  function fmtUsd(v: number): string {
    return v < 0.01 ? `$${v.toFixed(6)}` : `$${v.toFixed(4)}`;
  }
</script>

<nav>
  <a href="/security">← Security</a>
</nav>

<h1>AI cost dashboard</h1>

<p>
  Per-call token + cost accounting from the chat surface, last 30 days.
  Per-actor budgets and op-type caps land in <strong>P16</strong>.
</p>

<h2>Totals</h2>
<table>
  <tbody>
    <tr><td>Calls</td><td>{data.totals.calls}</td></tr>
    <tr><td>Input tokens</td><td>{data.totals.inputTokens.toLocaleString()}</td></tr>
    <tr><td>Output tokens</td><td>{data.totals.outputTokens.toLocaleString()}</td></tr>
    <tr><td>Cached tokens</td><td>{data.totals.cachedTokens.toLocaleString()}</td></tr>
    <tr><td>Estimated cost</td><td>{fmtUsd(data.totals.costUsd)}</td></tr>
  </tbody>
</table>

<h2>Per day</h2>
{#if data.perDay.length === 0}
  <p><em>No calls recorded yet.</em></p>
{:else}
  <table>
    <thead>
      <tr><th>Day</th><th>Calls</th><th>Input</th><th>Output</th><th>Cost</th></tr>
    </thead>
    <tbody>
      {#each data.perDay as d (d.day)}
        <tr>
          <td>{d.day}</td>
          <td>{d.calls}</td>
          <td>{d.inputTokens.toLocaleString()}</td>
          <td>{d.outputTokens.toLocaleString()}</td>
          <td>{fmtUsd(d.costUsd)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}
