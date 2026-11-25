<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { onMount } from "svelte";
  import { page, updated } from "$app/state";
  import { type ReloadMemory, reloadIfNewerRelease } from "#lib/version-skew.js";

  const MEMORY_KEY = "caelo:version-skew-reload";

  // sessionStorage can be missing or throw (private mode, blocked storage,
  // quota); then nothing is remembered and the page does not reload by
  // itself, since only a remembered guard stops a reload loop.
  const memory: ReloadMemory = {
    get() {
      try {
        return sessionStorage.getItem(MEMORY_KEY);
      } catch {
        return null;
      }
    },
    set(value) {
      try {
        sessionStorage.setItem(MEMORY_KEY, value);
      } catch {
        // Not remembered: reloadIfNewerRelease reads it back and skips the reload.
      }
    },
  };

  // #1656 — an error in a tab older than the deployed release is most
  // likely its old components reading the new release's data: reload once.
  // onMount, not $effect: `updated.check()` reads SvelteKit's `updated`
  // state, so an effect would run again when the check sets it and call
  // the reload twice.
  onMount(() => {
    void reloadIfNewerRelease(
      () => updated.check(),
      () => location.reload(),
      memory,
      location.href,
    );
  });
</script>

<main class="mx-auto max-w-xl px-6 py-16">
  <h1 class="text-2xl font-semibold">{page.status}</h1>
  <p class="text-muted-foreground mt-2">{page.error?.message}</p>
</main>
