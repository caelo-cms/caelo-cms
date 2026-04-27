<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * ChatPanel — the three-pane chat surface used by:
   *   - /content/chat/[sessionId] (admin chat editor)
   *   - P6.7's /edit live-edit overlay (re-mounts this same component
   *     inside the floating overlay).
   *
   * Holds transcript / composer / publish-and-diff sidebar. SSE streaming
   * to /content/chat/[sessionId]/stream stays untouched.
   */

  import { Lock, Unlock } from "lucide-svelte";
  import { onMount } from "svelte";
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { cn } from "$lib/utils.js";
  import type { ChatMessage, ChatModule, ChatSession } from "./types.js";

  interface Chip {
    moduleId: string;
    selector: string;
    label: string;
    /** When true the chip rides every send within this session (P6.7). */
    pinned?: boolean;
  }
  interface ProposedDiff {
    moduleId: string;
    before: string;
    after: string;
    selected: boolean;
  }

  /**
   * Callback fired on every successful `tool-result` SSE event. P6.7's
   * live-edit overlay subscribes here so it can postMessage a reload
   * to the iframe whenever the AI mutates a module. The chat editor at
   * /content/chat/[sessionId] doesn't pass this prop.
   */
  type ToolResultPayload = {
    toolCallId: string;
    ok: boolean;
    content: string;
    arguments?: { moduleId?: string; html?: string };
  };

  interface Props {
    session: ChatSession;
    initialMessages: ChatMessage[];
    modules: ChatModule[];
    csrfToken: string;
    formError?: string | null;
    /**
     * Sized-by-parent variant for the live-edit overlay. The default
     * uses `h-[calc(100vh-12rem)]` which is right inside AppShell but
     * overflows when embedded in the floating overlay.
     */
    compact?: boolean;
    /** P6.7.3 — when set, the runner gets a Current-page system block. */
    activePageId?: string | null;
    onToolResult?: (payload: ToolResultPayload) => void;
  }
  let {
    session,
    initialMessages,
    modules,
    csrfToken,
    formError = null,
    compact = false,
    activePageId = null,
    onToolResult,
  }: Props = $props();

  let messages = $state<ChatMessage[]>(initialMessages);
  let composer = $state("");
  let composerEl = $state<HTMLTextAreaElement | null>(null);
  let streaming = $state(false);

  /**
   * P6.7.4 — auto-grow the composer from one row up to 6, then scroll.
   * Called from `oninput` and after a send clears the value. Plain
   * function (not a Svelte effect) so it doesn't race with chip /
   * message state updates the way an `$effect` tracking
   * `composer.length` did.
   */
  function autoSizeComposer(): void {
    const el = composerEl;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = 22;
    const padding = 16;
    const maxRows = 6;
    const max = lineHeight * maxRows + padding;
    el.style.height = `${Math.min(max, el.scrollHeight)}px`;
  }
  let streamingText = $state("");
  let pendingChanges = $state(0);
  /** P6.7.3 — surface SSE error events + failed tool results so users
   *  see a banner instead of a silent no-op when the AI stack errors. */
  let chatError = $state<string | null>(null);
  // Pinned chips (from session.pinnedElements) ride every send; transient
  // chips (dropdown picks, iframe element-clicks) are sent once and cleared.
  let chips = $state<Chip[]>(
    (session.pinnedElements ?? []).map((p) => ({
      moduleId: p.moduleId,
      selector: p.selector,
      label: p.label,
      pinned: true,
    })),
  );
  let proposedDiffs = $state<ProposedDiff[]>([]);
  let pickedModuleId = $state("");

  const moduleStateBefore: Record<string, string> = {};
  for (const m of modules) {
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
    const removed = chips[idx];
    chips = chips.filter((_, i) => i !== idx);
    if (removed?.pinned) void persistPinned();
  }

  /**
   * Toggle the pinned flag on a chip. Pinned chips persist on the chat
   * session row and re-emit on every send within that chat. Pinning is a
   * UI affordance — the AI never reaches into pinned_elements.
   */
  async function togglePin(idx: number): Promise<void> {
    const c = chips[idx];
    if (!c) return;
    chips = chips.map((x, i) => (i === idx ? { ...x, pinned: !x.pinned } : x));
    await persistPinned();
  }

  async function persistPinned(): Promise<void> {
    const pinned = chips
      .filter((c) => c.pinned)
      .map((c) => ({ moduleId: c.moduleId, selector: c.selector, label: c.label }));
    try {
      await fetch("/edit/pinned", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ chatSessionId: session.id, pinnedElements: pinned }),
      });
    } catch {
      // best-effort
    }
  }

  /**
   * iframe → ChatPanel: a `caelo:chip` window CustomEvent (dispatched by
   * /edit/+page.svelte's postMessage handler) appends a new chip referring
   * to the clicked module. Append-only — multiple clicks accumulate so the
   * user can select N elements then send "make them all green" in one turn.
   */
  onMount(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as Chip | undefined;
      if (!detail || typeof detail.moduleId !== "string") return;
      // De-dupe: don't add a chip already present (pinned or not).
      if (chips.some((c) => c.moduleId === detail.moduleId && c.selector === detail.selector)) return;
      chips = [...chips, { ...detail }];
    };
    window.addEventListener("caelo:chip", handler);
    return () => window.removeEventListener("caelo:chip", handler);
  });

  async function sendMessage(): Promise<void> {
    if (composer.trim().length === 0 || streaming) return;
    const text = composer;
    const sentChips = chips;
    composer = "";
    chatError = null;
    // Pinned chips ride every send; transient chips clear after.
    chips = chips.filter((c) => c.pinned);
    streaming = true;
    streamingText = "";
    // Snap the composer back to one row after clearing it.
    queueMicrotask(autoSizeComposer);
    messages = [...messages, { id: `local-${Date.now()}`, role: "user", content: text }];
    const res = await fetch(`/content/chat/${session.id}/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({
        content: text,
        chips: sentChips,
        ...(activePageId ? { activePageId } : {}),
      }),
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
            if (ev["kind"] === "error") {
              chatError = typeof ev["message"] === "string" ? ev["message"] : "Chat failed.";
            } else if (ev["kind"] === "tool-result" && ev["ok"] === false) {
              chatError = `Tool call failed: ${String(ev["content"] ?? "unknown error")}`;
            } else if (ev["kind"] === "text-delta") streamingText += String(ev["text"] ?? "");
            else if (ev["kind"] === "tool-result" && ev["ok"]) {
              pendingChanges += 1;
              const args = (ev["arguments"] as { moduleId?: string; html?: string }) ?? {};
              if (typeof args.moduleId === "string" && typeof args.html === "string") {
                proposedDiffs = [
                  ...proposedDiffs,
                  {
                    moduleId: args.moduleId,
                    before: moduleStateBefore[args.moduleId] ?? "",
                    after: args.html,
                    selected: true,
                  },
                ];
              }
              // P6.7 — notify the live-edit overlay so it can reload
              // the iframe. The runtime payload has `arguments` only on
              // the `tool-start` event from the runner, but we forward
              // the args we have to keep the surface uniform.
              onToolResult?.({
                toolCallId: String(ev["toolCallId"] ?? ""),
                ok: true,
                content: String(ev["content"] ?? ""),
                arguments: args,
              });
            } else if (ev["kind"] === "tool-start") {
              const args = (ev["arguments"] as { moduleId?: string; html?: string }) ?? {};
              if (typeof args.moduleId === "string" && typeof args.html === "string") {
                proposedDiffs = [
                  ...proposedDiffs,
                  {
                    moduleId: args.moduleId,
                    before: moduleStateBefore[args.moduleId] ?? "",
                    after: args.html,
                    selected: true,
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

<div
  class={cn(
    compact ? "flex min-h-0 flex-1 flex-col gap-2 p-2" : "space-y-4",
  )}
>
  {#if !compact}
    <h1 class="text-2xl font-semibold tracking-tight">{session.title}</h1>
  {/if}

  {#if formError}
    <Alert variant="destructive"><AlertDescription>{formError}</AlertDescription></Alert>
  {/if}

  <div
    class={cn(
      compact ? "flex min-h-0 flex-1 flex-col" : "grid gap-4 lg:grid-cols-[1fr_320px]",
    )}
  >
    <!-- Transcript + composer -->
    <Card class={cn(compact && "flex min-h-0 flex-col")}>
      <CardContent
        class={cn(
          "flex flex-col gap-3 p-4",
          compact ? "min-h-0 flex-1" : "h-[calc(100vh-12rem)]",
        )}
      >
        <ul class="flex-1 space-y-2 overflow-y-auto">
          {#each messages as m (m.id)}
            <li
              class={cn(
                "rounded-md p-3 text-sm",
                m.role === "user"
                  ? "bg-primary/5"
                  : m.role === "tool"
                    ? "bg-emerald-500/10"
                    : "bg-muted",
              )}
            >
              <strong>
                {m.role === "user" ? "You" : m.role === "tool" ? "Tool" : "AI"}:
              </strong>
              <pre class="m-0 whitespace-pre-wrap font-sans">{m.content}</pre>
            </li>
          {/each}
          {#if streaming && streamingText.length > 0}
            <li class="rounded-md border-l-4 border-muted-foreground/40 bg-muted p-3 text-sm">
              <strong>AI:</strong>
              <pre class="m-0 whitespace-pre-wrap font-sans">{streamingText}</pre>
            </li>
          {/if}
          {#if chatError}
            <li data-testid="chat-error">
              <Alert variant="destructive">
                <AlertDescription>{chatError}</AlertDescription>
              </Alert>
            </li>
          {/if}
        </ul>

        {#if chips.length > 0}
          <div class="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
            <span class="self-center"><em>Module references attached:</em></span>
            {#each chips as c, i (`${c.moduleId}-${c.selector}-${i}`)}
              <span
                data-testid="chip"
                class={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-foreground",
                  c.pinned ? "bg-amber-500/15 ring-1 ring-amber-500/40" : "bg-primary/10",
                )}
              >
                {c.label}
                <button
                  type="button"
                  onclick={() => void togglePin(i)}
                  class="text-muted-foreground hover:text-foreground"
                  aria-label={c.pinned ? "Unpin chip" : "Pin chip across messages"}
                  title={c.pinned ? "Pinned across messages" : "Pin across messages"}
                >
                  {#if c.pinned}<Lock class="size-3" />{:else}<Unlock class="size-3" />{/if}
                </button>
                <button
                  type="button"
                  onclick={() => removeChip(i)}
                  class="text-muted-foreground hover:text-foreground"
                  aria-label="Remove chip">×</button
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
          class="space-y-2"
        >
          <Textarea
            bind:value={composer}
            bind:ref={composerEl}
            rows={1}
            placeholder="Tell the AI what to change…"
            class="resize-none"
            oninput={autoSizeComposer}
          />
          <div class="flex items-center gap-2">
            <Label for="picker" class="text-xs text-muted-foreground">+ Reference module</Label>
            <select
              id="picker"
              bind:value={pickedModuleId}
              onchange={addChipFromDropdown}
              class="flex h-8 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">…</option>
              {#each modules as m (m.id)}
                <option value={m.id}>{m.slug} — {m.displayName}</option>
              {/each}
            </select>
            <Button
              type="submit"
              size="sm"
              class="ml-auto"
              disabled={streaming || composer.trim().length === 0}
            >
              {streaming ? "…" : "Send"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>

    <!-- Sidebar: Publish + diff + rename. Hidden in compact (overlay)
         mode — the overlay carries its own Stage/Confirm strip and the
         diff view lives in the main /content/chat surface. -->
    {#if !compact}
    <aside class="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle class="text-base">Publish changes</CardTitle>
        </CardHeader>
        <CardContent class="space-y-3 text-sm">
          {#if session.publishedAt}
            <p class="text-muted-foreground"><em>Already published.</em></p>
          {:else if pendingChanges === 0}
            <p class="text-muted-foreground"><em>No pending changes.</em></p>
          {:else}
            <p>{pendingChanges} pending change{pendingChanges === 1 ? "" : "s"}.</p>
            <form method="post" action="?/publish" class="space-y-2">
              <input type="hidden" name="_csrf" value={csrfToken} />
              {#if proposedDiffs.length > 0}
                <ul class="space-y-1">
                  {#each proposedDiffs as d, i (`${d.moduleId}-${i}`)}
                    <li>
                      <label class="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name="entity"
                          value={`module:${d.moduleId}`}
                          checked={d.selected}
                          class="h-4 w-4 rounded border-input"
                        />
                        module {d.moduleId.slice(0, 8)}
                      </label>
                    </li>
                  {/each}
                </ul>
                <p class="text-xs text-muted-foreground">
                  Untick to leave the change on the chat branch.
                </p>
              {/if}
              <Button type="submit" size="sm">Publish</Button>
            </form>
          {/if}
        </CardContent>
      </Card>

      {#if proposedDiffs.length > 0}
        <Card>
          <CardHeader>
            <CardTitle class="text-base">Visual diff</CardTitle>
          </CardHeader>
          <CardContent class="space-y-2 font-mono text-xs">
            {#each proposedDiffs as d (`${d.moduleId}-${d.after.slice(0, 16)}`)}
              <div>
                <strong>module {d.moduleId.slice(0, 8)}</strong>
                <pre class="m-0 whitespace-pre-wrap">{#each lineDiff(d.before, d.after) as ln, i (i)}<span
                      class={cn(
                        "block",
                        ln.kind === "add"
                          ? "bg-green-500/10"
                          : ln.kind === "del"
                            ? "bg-red-500/10"
                            : "",
                      )}
                      >{ln.kind === "add" ? "+ " : ln.kind === "del" ? "- " : "  "}{ln.text}</span
                    >{/each}</pre>
              </div>
            {/each}
          </CardContent>
        </Card>
      {/if}

      <Card>
        <CardHeader>
          <CardTitle class="text-base">Rename</CardTitle>
        </CardHeader>
        <CardContent>
          <form method="post" action="?/rename" class="flex items-center gap-2">
            <input type="hidden" name="_csrf" value={csrfToken} />
            <Input name="title" type="text" value={session.title} />
            <Button type="submit" size="sm" variant="outline">Rename</Button>
          </form>
        </CardContent>
      </Card>
    </aside>
    {/if}
  </div>
</div>
