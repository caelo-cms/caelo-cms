<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import ChatPanel from "$lib/components/chat/ChatPanel.svelte";

  let { data, form } = $props();

  // v0.2.46 — debug panel toggle. Reactive so toggling ?debug=1 in
  // the URL flips it without reload. Permission gate happens in the
  // server load (data.canDebug); this just consumes the flag.
  // v0.2.55 — also toggleable via a button inside ChatPanel. The
  // button calls toggleDebug which flips the URL param so the state
  // survives reload + can be shared as a deep link.
  let debugFlag = $state(page.url.searchParams.get("debug") === "1");
  const debug = $derived(debugFlag && data.canDebug === true);

  function toggleDebug(): void {
    debugFlag = !debugFlag;
    const url = new URL(window.location.href);
    if (debugFlag) url.searchParams.set("debug", "1");
    else url.searchParams.delete("debug");
    window.history.replaceState({}, "", url.toString());
  }

  // P8 review-pass: the SEO panel's Autofill / Re-optimize buttons
  // create a chat with `?prompt=<text>`. ChatPanel already listens
  // for the `caelo:insert-into-composer` CustomEvent (P7 wiring for
  // the /edit MediaPicker), so we re-use it here. Fire once on mount
  // and clear the URL param so a rerender doesn't replay.
  onMount(() => {
    const prompt = page.url.searchParams.get("prompt");
    if (prompt && prompt.length > 0) {
      document.dispatchEvent(
        new CustomEvent("caelo:insert-into-composer", { detail: { text: prompt } }),
      );
      const next = new URL(window.location.href);
      next.searchParams.delete("prompt");
      window.history.replaceState({}, "", next.toString());
    }
  });
</script>

<ChatPanel
  session={data.session}
  initialMessages={data.messages}
  modules={data.modules}
  csrfToken={data.csrfToken}
  formError={form?.error ?? null}
  {debug}
  canDebug={data.canDebug}
  onToggleDebug={toggleDebug}
/>
