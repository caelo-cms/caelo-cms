<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  let { children } = $props();
</script>

<div class="flex min-h-screen items-center justify-center bg-background px-4 py-12">
  <div class="w-full max-w-sm">
    {@render children()}
  </div>
</div>
