<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  let { data, form } = $props();
  const session = data.session as {
    id: string;
    title: string;
    chatBranchId: string;
    publishedAt: string | null;
  };
  type Msg = { id: string; role: "user" | "assistant" | "tool"; content: string };
  let messages = $state<Msg[]>(data.messages as Msg[]);
  let composer = $state("");
  let streaming = $state(false);
  let streamingText = $state("");
  let pendingChanges = $state(0);

  async function sendMessage(): Promise<void> {
    if (composer.trim().length === 0 || streaming) return;
    const text = composer;
    composer = "";
    streaming = true;
    streamingText = "";
    messages = [...messages, { id: `local-${Date.now()}`, role: "user", content: text }];
    const res = await fetch(`/content/chat/${session.id}/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": data.csrfToken },
      body: JSON.stringify({ content: text, chips: [] }),
    });
    if (!res.body) {
      streaming = false;
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (line.startsWith("data: ")) {
          try {
            const ev = JSON.parse(line.slice(6)) as Record<string, unknown>;
            if (ev["kind"] === "text-delta") streamingText += String(ev["text"] ?? "");
            else if (ev["kind"] === "tool-result" && ev["ok"]) pendingChanges += 1;
            else if (ev["kind"] === "done") {
              if (streamingText.length > 0) {
                messages = [
                  ...messages,
                  { id: `local-a-${Date.now()}`, role: "assistant", content: streamingText },
                ];
              }
              streamingText = "";
              streaming = false;
            }
          } catch {
            // Tolerate non-JSON keepalive lines.
          }
        }
      }
    }
    streaming = false;
  }
</script>

<nav>
  <a href="/content/chat">← Chats</a>
</nav>

<h1>{session.title}</h1>

{#if form?.error}<p class="error">{form.error}</p>{/if}

<div style="display: flex; gap: 1rem; align-items: flex-start">
  <div style="flex: 1; max-width: 700px">
    <ul style="list-style: none; padding: 0; max-height: 500px; overflow-y: auto">
      {#each messages as m (m.id)}
        <li
          style="margin-bottom: 0.5rem; padding: 0.5rem; background: {m.role === 'user'
            ? '#eef'
            : m.role === 'tool'
              ? '#efe'
              : '#fafafa'}"
        >
          <strong>{m.role === "user" ? "You" : m.role === "tool" ? "Tool" : "AI"}:</strong>
          <pre style="white-space: pre-wrap; margin: 0">{m.content}</pre>
        </li>
      {/each}
      {#if streaming && streamingText.length > 0}
        <li style="padding: 0.5rem; background: #fafafa; border-left: 3px solid #999">
          <strong>AI:</strong>
          <pre style="white-space: pre-wrap; margin: 0">{streamingText}</pre>
        </li>
      {/if}
    </ul>

    <form
      onsubmit={(e) => {
        e.preventDefault();
        void sendMessage();
      }}
    >
      <textarea
        bind:value={composer}
        rows="3"
        cols="80"
        placeholder="Tell the AI what to change…"
      ></textarea>
      <br />
      <button type="submit" disabled={streaming || composer.trim().length === 0}>
        {streaming ? "…" : "Send"}
      </button>
    </form>
  </div>

  <aside style="flex: 0 0 240px; padding: 0.75rem; background: #f7f7f7">
    <h3>Publish changes</h3>
    {#if session.publishedAt}
      <p><em>Already published.</em></p>
    {:else if pendingChanges === 0}
      <p><em>No pending changes.</em></p>
    {:else}
      <p>{pendingChanges} pending change{pendingChanges === 1 ? "" : "s"}.</p>
      <form method="post" action="?/publish">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <button type="submit">Publish</button>
      </form>
    {/if}

    <h3 style="margin-top: 1.5rem">Rename</h3>
    <form method="post" action="?/rename">
      <input type="hidden" name="_csrf" value={data.csrfToken} />
      <input name="title" type="text" value={session.title} />
      <button type="submit">Rename</button>
    </form>
  </aside>
</div>
