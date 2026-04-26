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
  type Chip = { moduleId: string; selector: string; label: string };
  type ProposedDiff = { moduleId: string; before: string; after: string };
  let messages = $state<Msg[]>(data.messages as Msg[]);
  let composer = $state("");
  let streaming = $state(false);
  let streamingText = $state("");
  let pendingChanges = $state(0);
  let chips = $state<Chip[]>([]);
  let proposedDiffs = $state<ProposedDiff[]>([]);
  /** Module reference dropdown — alternative to the in-iframe pencil
   * affordance (which lands alongside the proper preview-pane overhaul
   * in P5.1). Adds a chip for the picked module. */
  let pickedModuleId = $state("");
  const modules = data.modules as { id: string; slug: string; displayName: string }[];

  // Snapshot every module's current state so we can compute a visual
  // diff after each tool call without an extra DB roundtrip.
  const moduleStateBefore: Record<string, string> = {};
  for (const m of modules as { id: string; html?: string }[]) {
    if (typeof m.html === "string") moduleStateBefore[m.id] = m.html;
  }

  function addChipFromDropdown(): void {
    if (!pickedModuleId) return;
    const m = modules.find((x) => x.id === pickedModuleId);
    if (!m) return;
    chips = [
      ...chips,
      { moduleId: m.id, selector: "", label: `${m.slug} — ${m.displayName}` },
    ];
    pickedModuleId = "";
  }

  function removeChip(idx: number): void {
    chips = chips.filter((_, i) => i !== idx);
  }

  async function sendMessage(): Promise<void> {
    if (composer.trim().length === 0 || streaming) return;
    const text = composer;
    const sentChips = chips;
    composer = "";
    chips = [];
    streaming = true;
    streamingText = "";
    messages = [...messages, { id: `local-${Date.now()}`, role: "user", content: text }];
    const res = await fetch(`/content/chat/${session.id}/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": data.csrfToken },
      body: JSON.stringify({ content: text, chips: sentChips }),
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
            else if (ev["kind"] === "tool-result" && ev["ok"]) {
              pendingChanges += 1;
              // Try to capture the proposed module HTML for the visual
              // diff. The tool-start event right before this carried the
              // arguments — but we only persist the result here. Re-fetch
              // the module's current state and compare against
              // moduleStateBefore.
              const args = (ev["arguments"] as { moduleId?: string; html?: string }) ?? {};
              if (typeof args.moduleId === "string" && typeof args.html === "string") {
                proposedDiffs = [
                  ...proposedDiffs,
                  {
                    moduleId: args.moduleId,
                    before: moduleStateBefore[args.moduleId] ?? "",
                    after: args.html,
                  },
                ];
              }
            } else if (ev["kind"] === "tool-start") {
              const args = (ev["arguments"] as { moduleId?: string; html?: string }) ?? {};
              if (typeof args.moduleId === "string" && typeof args.html === "string") {
                proposedDiffs = [
                  ...proposedDiffs,
                  {
                    moduleId: args.moduleId,
                    before: moduleStateBefore[args.moduleId] ?? "",
                    after: args.html,
                  },
                ];
              }
            } else if (ev["kind"] === "done") {
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

  function lineDiff(before: string, after: string): { kind: "ctx" | "del" | "add"; text: string }[] {
    const a = before.split("\n");
    const b = after.split("\n");
    const out: { kind: "ctx" | "del" | "add"; text: string }[] = [];
    // Tiny LCS-free diff: lines present in both at the same index → ctx;
    // others → del then add. Good enough for the inline preview UI.
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      if (a[i] === b[i]) {
        if (a[i] !== undefined) out.push({ kind: "ctx", text: a[i] ?? "" });
      } else {
        if (a[i] !== undefined) out.push({ kind: "del", text: a[i] ?? "" });
        if (b[i] !== undefined) out.push({ kind: "add", text: b[i] ?? "" });
      }
    }
    return out;
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

    {#if chips.length > 0}
      <div style="margin-bottom: 0.5rem">
        <em>Module references attached:</em>
        {#each chips as c, i (`${c.moduleId}-${i}`)}
          <span
            style="display: inline-block; margin: 0.15rem; padding: 0.15rem 0.4rem; background: #def; border-radius: 0.25rem"
          >
            {c.label}
            <button
              type="button"
              onclick={() => removeChip(i)}
              style="background: none; border: 0; cursor: pointer">×</button
            >
          </span>
        {/each}
      </div>
    {/if}

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
      <label>
        + Reference module
        <select bind:value={pickedModuleId} onchange={addChipFromDropdown}>
          <option value="">…</option>
          {#each modules as m (m.id)}
            <option value={m.id}>{m.slug} — {m.displayName}</option>
          {/each}
        </select>
      </label>
      <button type="submit" disabled={streaming || composer.trim().length === 0}>
        {streaming ? "…" : "Send"}
      </button>
    </form>
  </div>

  <aside style="flex: 0 0 280px; padding: 0.75rem; background: #f7f7f7">
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

    {#if proposedDiffs.length > 0}
      <h3 style="margin-top: 1rem">Visual diff</h3>
      {#each proposedDiffs as d (`${d.moduleId}-${d.after.slice(0, 16)}`)}
        <div style="margin-bottom: 0.5rem; font-family: ui-monospace, monospace; font-size: 0.8rem">
          <strong>module {d.moduleId.slice(0, 8)}</strong>
          <pre style="margin: 0; white-space: pre-wrap">{#each lineDiff(d.before, d.after) as ln, i (i)}<span
                style="display: block; background: {ln.kind === 'add'
                  ? '#dfd'
                  : ln.kind === 'del'
                    ? '#fdd'
                    : 'transparent'}"
                >{ln.kind === "add" ? "+ " : ln.kind === "del" ? "- " : "  "}{ln.text}</span
              >{/each}</pre>
        </div>
      {/each}
    {/if}

    <h3 style="margin-top: 1rem">Rename</h3>
    <form method="post" action="?/rename">
      <input type="hidden" name="_csrf" value={data.csrfToken} />
      <input name="title" type="text" value={session.title} />
      <button type="submit">Rename</button>
    </form>
  </aside>
</div>
