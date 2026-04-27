<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import ChatPanel from "$lib/components/chat/ChatPanel.svelte";

  let { data, form } = $props();
</script>

<ChatPanel
  session={data.session}
  initialMessages={data.messages}
  modules={data.modules}
  csrfToken={data.csrfToken}
  formError={form?.error ?? null}
/>
