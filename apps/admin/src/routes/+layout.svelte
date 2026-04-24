<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  let { children } = $props();
</script>

<main>
  {@render children()}
</main>

<style>
  :global(body) {
    font-family:
      system-ui,
      -apple-system,
      sans-serif;
    max-width: 48rem;
    margin: 2rem auto;
    padding: 0 1rem;
    color: #222;
  }

  :global(h1) {
    font-size: 1.5rem;
  }

  :global(form) {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-width: 24rem;
  }

  :global(input, button) {
    padding: 0.5rem;
    font-size: 1rem;
  }

  :global(.error) {
    color: #b00;
  }

  :global(nav a) {
    margin-right: 1rem;
  }
</style>
