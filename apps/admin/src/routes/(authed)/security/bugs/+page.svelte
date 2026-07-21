<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Bug, Copy, Download } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import EmptyStatePlaceholder from "$lib/components/EmptyStatePlaceholder.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { cn } from "$lib/utils.js";
  import type { BugReport } from "./+page.server";

  let { data }: { data: { reports: BugReport[] } } = $props();
  const reports = $derived(data.reports);

  let expanded = $state<Record<string, boolean>>({});
  const toggle = (id: string) => (expanded[id] = !expanded[id]);

  const severityClass = (s: string): string =>
    s === "blocking"
      ? "bg-destructive/15 text-destructive"
      : s === "degraded"
        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
        : "bg-muted text-muted-foreground";

  function toMarkdown(rs: BugReport[]): string {
    const head = `# Caelo — AI-detected bugs (${rs.length})\n\n_Exported ${new Date().toISOString()}_\n`;
    const body = rs
      .map(
        (r, i) =>
          `\n## ${i + 1}. ${r.title}\n\n` +
          `- **Severity:** ${r.severity}${r.blockedTask ? " (blocked the task)" : ""}\n` +
          `- **Status:** ${r.status}\n` +
          `- **When:** ${r.createdAt}\n` +
          (r.suspectedTool ? `- **Suspected tool:** \`${r.suspectedTool}\`\n` : "") +
          (r.chatSessionId ? `- **Chat session:** ${r.chatSessionId}\n` : "") +
          `\n**What happened**\n\n${r.whatHappened}\n\n` +
          `**Expected**\n\n${r.expected}\n` +
          (r.evidence ? `\n**Evidence**\n\n\`\`\`\n${r.evidence}\n\`\`\`\n` : ""),
      )
      .join("");
    return head + body;
  }

  async function copyMarkdown(): Promise<void> {
    try {
      await navigator.clipboard.writeText(toMarkdown(reports));
      toast.success(`Copied ${reports.length} bug report(s) as Markdown — paste into a GitHub issue.`);
    } catch {
      toast.error("Could not copy to clipboard.");
    }
  }

  function downloadJson(): void {
    const blob = new Blob([JSON.stringify(reports, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `caelo-detected-bugs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Downloaded ${reports.length} bug report(s) as JSON.`);
  }
</script>

<svelte:head><title>Detected bugs · Caelo</title></svelte:head>

<div class="space-y-6">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Detected bugs</h1>
      <p class="mt-1 max-w-2xl text-sm text-muted-foreground">
        Defects the AI flagged while working — it filed these and continued with a workaround. Hit a
        problem? Export the list and send it to us, or paste it into a GitHub issue.
      </p>
    </div>
    <div class="flex gap-2">
      <Button variant="outline" size="sm" onclick={copyMarkdown} disabled={reports.length === 0}>
        <Copy class="mr-2 size-4" /> Copy as Markdown
      </Button>
      <Button variant="outline" size="sm" onclick={downloadJson} disabled={reports.length === 0}>
        <Download class="mr-2 size-4" /> Download JSON
      </Button>
    </div>
  </div>

  {#if reports.length === 0}
    <EmptyStatePlaceholder
      icon={Bug}
      title="No bugs detected"
      description="When the AI runs into a tool behaving contrary to its contract, it files a report here. An empty list is a good sign."
    />
  {:else}
    <div class="overflow-x-auto rounded-lg border">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">Title</th>
            <th class="px-4 py-2 font-medium">Severity</th>
            <th class="px-4 py-2 font-medium">Status</th>
            <th class="px-4 py-2 font-medium">Suspected tool</th>
            <th class="px-4 py-2 font-medium">When</th>
          </tr>
        </thead>
        <tbody>
          {#each reports as r (r.id)}
            <tr
              class="cursor-pointer border-b last:border-0 hover:bg-muted/30"
              onclick={() => toggle(r.id)}
            >
              <td class="px-4 py-2 font-medium">{r.title}</td>
              <td class="px-4 py-2">
                <span class={cn("rounded px-1.5 py-0.5 text-xs font-medium", severityClass(r.severity))}>
                  {r.severity}
                </span>
              </td>
              <td class="px-4 py-2 text-muted-foreground">{r.status}</td>
              <td class="px-4 py-2 font-mono text-xs text-muted-foreground">{r.suspectedTool ?? "—"}</td>
              <td class="px-4 py-2 whitespace-nowrap text-xs text-muted-foreground">
                {new Date(r.createdAt).toLocaleString()}
              </td>
            </tr>
            {#if expanded[r.id]}
              <tr class="border-b bg-muted/20 last:border-0">
                <td colspan="5" class="space-y-3 px-4 py-3 text-sm">
                  <div>
                    <div class="text-xs font-semibold uppercase text-muted-foreground">What happened</div>
                    <p class="mt-0.5 whitespace-pre-wrap">{r.whatHappened}</p>
                  </div>
                  <div>
                    <div class="text-xs font-semibold uppercase text-muted-foreground">Expected</div>
                    <p class="mt-0.5 whitespace-pre-wrap">{r.expected}</p>
                  </div>
                  {#if r.evidence}
                    <div>
                      <div class="text-xs font-semibold uppercase text-muted-foreground">Evidence</div>
                      <pre class="mt-0.5 overflow-x-auto rounded bg-muted p-2 text-xs">{r.evidence}</pre>
                    </div>
                  {/if}
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
