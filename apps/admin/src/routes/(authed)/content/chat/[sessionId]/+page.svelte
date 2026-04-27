<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import ChatPanel from "$lib/components/chat/ChatPanel.svelte";

  let { data, form } = $props();
</script>

<ChatPanel
  session={data.session as never}
  initialMessages={data.messages as never}
  modules={data.modules as never}
  csrfToken={data.csrfToken}
  formError={form?.error ?? null}
/>
