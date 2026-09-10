<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { enhance } from '$app/forms';
  import { Button } from '$lib/components/ui/button/index.js';
  let { data, form } = $props();
</script>

<div class="space-y-6">
  <a href="/security/plugins" class="text-sm underline">Back to plugins</a>
  <h1 class="text-2xl font-semibold">External plugin installations</h1>
  <p>Upload a package, review its source, and approve each requested access. Updates require a new review. The current version keeps running until its replacement is ready.</p>
  {#if form?.error}<p role="alert" class="rounded border border-red-500 p-3">{form.error}</p>{/if}
  {#if form?.ok}<p role="status" class="rounded border p-3">{form.message}</p>{/if}
  <form method="post" action="?/stage" enctype="multipart/form-data" use:enhance class="flex flex-wrap items-end gap-3">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
    <label class="grid gap-2">Plugin package (.json)<input type="file" name="package" accept=".json,application/json" required /></label>
    <Button type="submit">Submit package for review</Button>
  </form>
  {#each data.installations as item (item.id)}
    <article class="space-y-3 rounded border p-4" data-testid="installation-{item.slug}">
      <h2 class="font-semibold">{item.slug} {item.manifest.version}</h2>
      <p class="text-sm">Review: {item.status}. Current plugin: {item.currentStatus}. Origin: {item.origin}.</p>
      <p class="break-all font-mono text-xs">Package SHA-256: {item.artifactDigest}</p>
      <details><summary class="cursor-pointer">Review package source and manifest</summary>
        <h3 class="mt-3 font-semibold">Requested manifest</h3><pre class="max-h-72 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(item.manifest, null, 2)}</pre>
        <h3 class="mt-3 font-semibold">Source</h3><pre class="max-h-72 overflow-auto whitespace-pre-wrap text-xs">{item.source}</pre>
        <h3 class="mt-3 font-semibold">Current manifest</h3><pre class="max-h-72 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(item.currentManifest, null, 2)}</pre>
      </details>
      {#if item.status === 'pending' || item.status === 'retired' || (item.status === 'active' && item.currentStatus === 'disabled')}
        <form method="post" action="?/approve" use:enhance class="space-y-3">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <input type="hidden" name="installationId" value={item.id} />
          <input type="hidden" name="artifactDigest" value={item.artifactDigest} />
          <input type="hidden" name="expectedStateDigest" value={item.currentStateDigest} />
          <fieldset class="space-y-2"><legend class="font-semibold">Requested access</legend>
            {#each item.manifest.requestedCapabilities ?? [] as capability}
              <label class="flex items-start gap-2"><input type="checkbox" name="capability" value={capability} required />
                <span><strong>{capability}</strong>: {item.manifest.capabilityReasons?.[capability]}
                  {#if item.manifest.capabilityConstraints?.[capability]}<span class="block text-xs">Scope: {JSON.stringify(item.manifest.capabilityConstraints[capability])}</span>{/if}
                </span>
              </label>
            {/each}
          </fieldset>
          <Button type="submit">Approve selected access and activate</Button>
        </form>
      {:else if item.status === 'approved' || (item.status === 'active' && item.currentStatus === 'active')}
        <form method="post" action="?/retry" use:enhance>
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <input type="hidden" name="installationId" value={item.id} /><Button type="submit">{item.status === 'active' ? 'Reload approved installation' : 'Retry approved installation'}</Button>
        </form>
      {/if}
      {#if item.status === 'active' || item.status === 'approved'}
        {#each item.manifest.requestedCapabilities ?? [] as capability}
          <form method="post" action="?/revoke" use:enhance>
          <input type="hidden" name="_csrf" value={data.csrfToken} />
            <input type="hidden" name="installationId" value={item.id} /><input type="hidden" name="capability" value={capability} />
            <Button type="submit" variant="outline">Revoke {capability}</Button>
          </form>
        {/each}
      {/if}
    </article>
  {/each}
</div>
