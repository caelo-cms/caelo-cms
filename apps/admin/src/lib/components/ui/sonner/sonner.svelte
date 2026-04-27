<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Toaster as SonnerToaster } from "svelte-sonner";
  import { ModeWatcher, mode } from "mode-watcher";
</script>

<ModeWatcher />
<SonnerToaster
  theme={mode.current === "dark" ? "dark" : "light"}
  richColors
  closeButton
  position="top-right"
/>
