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
  }
  interface ProposedDiff {
    moduleId: string;
    before: string;
    after: string;
    selected: boolean;
  }

  interface Props {
    session: ChatSession;
    initialMessages: ChatMessage[];
    modules: ChatModule[];
    csrfToken: string;
    formError?: string | null;
  }
  let { session, initialMessages, modules, csrfToken, formError = null }: Props = $props();

  let messages = $state<ChatMessage[]>(initialMessages);
  let composer = $state("");
  let streaming = $state(false);
  let streamingText = $state("");
  let pendingChanges = $state(0);
  let chips = $state<Chip[]>([]);
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
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
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

<div class="space-y-4">
  <h1 class="text-2xl font-semibold tracking-tight">{session.title}</h1>

  {#if formError}
    <Alert variant="destructive"><AlertDescription>{formError}</AlertDescription></Alert>
  {/if}

  <div class="grid gap-4 lg:grid-cols-[1fr_320px]">
    <!-- Transcript + composer -->
    <Card>
      <CardContent class="flex h-[calc(100vh-12rem)] flex-col gap-3 p-4">
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
        </ul>

        {#if chips.length > 0}
          <div class="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
            <span class="self-center"><em>Module references attached:</em></span>
            {#each chips as c, i (`${c.moduleId}-${i}`)}
              <span class="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-foreground">
                {c.label}
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
            rows={3}
            placeholder="Tell the AI what to change…"
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

    <!-- Sidebar: Publish + diff + rename -->
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
  </div>
</div>
