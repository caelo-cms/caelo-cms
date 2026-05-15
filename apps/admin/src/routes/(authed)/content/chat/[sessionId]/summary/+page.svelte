<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { ArrowLeft, CircleCheck, CircleX, Clock, ListTree } from "lucide-svelte";
  import { buttonVariants } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";

  let { data } = $props();
  const s = $derived(data.summary);

  function fmtMs(ms: number | null): string {
    if (ms == null) return "—";
    if (ms < 1000) return `${ms}ms`;
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const r = sec % 60;
    return r === 0 ? `${m}m` : `${m}m ${r}s`;
  }
</script>

<div class="mx-auto max-w-4xl space-y-6 p-4">
  <div class="flex items-center gap-2">
    <a
      href={`/content/chat/${s.chatSessionId}`}
      class={buttonVariants({ variant: "ghost", size: "sm" })}
      data-testid="back-to-chat"
    >
      <ArrowLeft class="mr-1 size-4" />
      Back to chat
    </a>
    <div class="ml-2">
      <h1 class="text-xl font-semibold tracking-tight">
        {s.title ?? "Untitled chat"}
      </h1>
      <p class="text-xs text-muted-foreground font-mono">{s.chatSessionId}</p>
    </div>
  </div>

  <!-- Stat cards -->
  <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
    <Card>
      <CardContent class="p-4">
        <div class="flex items-center gap-2 text-xs text-muted-foreground">
          <ListTree class="size-3" />
          Total tool calls
        </div>
        <div class="mt-1 text-2xl font-semibold" data-testid="stat-total">{s.totalToolCalls}</div>
      </CardContent>
    </Card>
    <Card>
      <CardContent class="p-4">
        <div class="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-400">
          <CircleCheck class="size-3" />
          Succeeded
        </div>
        <div class="mt-1 text-2xl font-semibold text-emerald-700 dark:text-emerald-400" data-testid="stat-success">
          {s.successCount}
        </div>
      </CardContent>
    </Card>
    <Card>
      <CardContent class="p-4">
        <div class="flex items-center gap-2 text-xs text-destructive">
          <CircleX class="size-3" />
          Failed
        </div>
        <div class="mt-1 text-2xl font-semibold text-destructive" data-testid="stat-failed">
          {s.failureCount}
        </div>
      </CardContent>
    </Card>
    <Card>
      <CardContent class="p-4">
        <div class="flex items-center gap-2 text-xs text-muted-foreground">
          <Clock class="size-3" />
          Duration
        </div>
        <div class="mt-1 text-2xl font-semibold">{fmtMs(s.durationMs)}</div>
        <div class="text-xs text-muted-foreground">{s.loopCount} loop{s.loopCount === 1 ? "" : "s"}</div>
      </CardContent>
    </Card>
  </div>

  <!-- Per-tool breakdown -->
  <Card>
    <CardHeader>
      <CardTitle class="text-base">Per-tool breakdown</CardTitle>
    </CardHeader>
    <CardContent>
      {#if s.byTool.length === 0}
        <p class="text-sm text-muted-foreground"><em>No tool calls in this chat.</em></p>
      {:else}
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b text-left text-xs text-muted-foreground">
              <th class="py-2 font-medium">Tool</th>
              <th class="py-2 text-right font-medium">OK</th>
              <th class="py-2 text-right font-medium">Failed</th>
            </tr>
          </thead>
          <tbody>
            {#each s.byTool as t (t.name)}
              <tr class="border-b last:border-b-0" data-testid={`row-${t.name}`}>
                <td class="py-2 font-mono text-xs">{t.name}</td>
                <td class="py-2 text-right tabular-nums">{t.ok}</td>
                <td class="py-2 text-right tabular-nums">
                  {#if t.failed > 0}
                    <span class="text-destructive">{t.failed}</span>
                  {:else}
                    {t.failed}
                  {/if}
                </td>
              </tr>
              {#if t.failures.length > 0}
                <tr class="border-b last:border-b-0 bg-muted/20">
                  <td colspan="3" class="px-2 py-2">
                    <details>
                      <summary class="cursor-pointer text-xs font-medium text-destructive">
                        {t.failures.length} failure sample{t.failures.length === 1 ? "" : "s"}
                      </summary>
                      <ul class="mt-2 space-y-2">
                        {#each t.failures as f (f.messageId)}
                          <li class="rounded border border-destructive/30 bg-destructive/5 p-2">
                            <div class="text-[10px] text-muted-foreground">
                              {new Date(f.createdAt).toISOString().slice(11, 19)}Z
                            </div>
                            <pre class="mt-1 whitespace-pre-wrap text-xs">{f.content}</pre>
                          </li>
                        {/each}
                      </ul>
                    </details>
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      {/if}
    </CardContent>
  </Card>

  {#if s.failureCount > 0}
    <div class="text-center">
      <a
        href={`/content/chat/${s.chatSessionId}?filter=failed`}
        class={buttonVariants({ variant: "outline", size: "sm" })}
      >
        Open chat with failed-only filter
      </a>
    </div>
  {/if}
</div>
