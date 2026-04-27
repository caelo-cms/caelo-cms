<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import "../app.css";
  import { Toaster } from "$lib/components/ui/sonner/index.js";
  let { children } = $props();
</script>

{@render children()}
<Toaster />
