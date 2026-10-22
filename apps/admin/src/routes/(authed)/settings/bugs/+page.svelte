<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Bug, Copy, Download, ExternalLink, Send } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import { unsentReportsSummary } from "#lib/bug-forwarding-summary.js";
  import EmptyStatePlaceholder from "#lib/components/EmptyStatePlaceholder.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";
  import { cn } from "#lib/utils.js";
  import type { BugForwarding, BugReport } from "./+page.server";

  let {
    data,
  }: { data: { reports: BugReport[]; forwarding: BugForwarding; csrfToken: string } } = $props();
  const reports = $derived(data.reports);
  const forwarding = $derived(data.forwarding);
  const unsentSummary = $derived(unsentReportsSummary(reports.map((r) => r.forwardingState)));

  // The exact payload per report, fetched on demand and kept in component
  // state only (never in the page's hydration data).
  let previews = $state<Record<string, string>>({});
  async function loadPreview(id: string): Promise<void> {
    const r = await fetch(`/settings/bugs/preview?id=${encodeURIComponent(id)}`);
    previews[id] = r.ok ? await r.text() : `Could not build the preview (HTTP ${r.status}).`;
  }

  let expanded = $state<Record<string, boolean>>({});
  const toggle = (id: string) => (expanded[id] = !expanded[id]);
  const onRowKey = (id: string) => (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle(id);
    }
  };

  const severityClass = (s: string): string =>
    s === "blocking"
      ? "bg-destructive/15 text-destructive"
      : s === "degraded"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
        : "bg-muted text-muted-foreground";

  const upstreamLabel = (r: BugReport): string | null => {
    if (r.forwardingState !== "sent" || r.upstreamStatus === null) return null;
    if (r.upstreamStatus === "fixed") {
      return r.upstreamFixedIn ? `Fixed in ${r.upstreamFixedIn}` : "Fixed";
    }
    if (r.upstreamStatus === "regression") return "Came back, reopened";
    if (r.upstreamStatus === "wontfix") return "Won't be fixed";
    return "Known, being worked on";
  };

  const forwardingLabel: Record<BugReport["forwardingState"], { label: string; hint: string }> = {
    local_only: { label: "This site only", hint: "Stored on this site. The Caelo team has not received it." },
    queued: { label: "Queued", hint: "Will be sent to the Caelo team automatically." },
    sent: { label: "Sent", hint: "The Caelo team received this report." },
    failed: {
      label: "Not sent",
      hint: "Sending to the Caelo team failed. It is stored on this site; while sending is on, the Send button above tries again.",
    },
  };

  // A fenced code block's fence must be LONGER than any backtick run it
  // contains (CommonMark), else evidence with a ``` snippet breaks the export.
  function fenceFor(s: string): string {
    const longestRun = Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
    return "`".repeat(Math.max(3, longestRun + 1));
  }

  function toMarkdown(rs: BugReport[]): string {
    const head = `# Caelo — AI-detected bugs (${rs.length})\n\n_Exported ${new Date().toISOString()}_\n`;
    const body = rs
      .map(
        (r, i) =>
          `\n## ${i + 1}. ${r.title}\n\n` +
          `- **Severity:** ${r.severity}${r.blockedTask ? " (blocked the task)" : ""}\n` +
          `- **Source:** ${r.source === "auto" ? "auto-captured" : "AI-filed"}\n` +
          `- **Status:** ${r.status}\n` +
          `- **When:** ${r.createdAt}\n` +
          (r.suspectedTool ? `- **Suspected tool:** \`${r.suspectedTool}\`\n` : "") +
          (r.chatSessionId ? `- **Chat session:** ${r.chatSessionId}\n` : "") +
          `\n**What happened**\n\n${r.whatHappened}\n\n` +
          `**Expected**\n\n${r.expected}\n` +
          (r.evidence
            ? `\n**Evidence**\n\n${fenceFor(r.evidence)}\n${r.evidence}\n${fenceFor(r.evidence)}\n`
            : ""),
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
        Defects the AI flagged while working — it filed these and continued with a workaround.
        <!-- With forwarding on, the card below offers the one-click send for
             unsent reports; the manual-export hint only applies when off. -->
        {#if unsentSummary && !forwarding.enabled}{unsentSummary}{/if}
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

  <Card data-testid="bug-forwarding">
    <CardHeader>
      <CardTitle class="text-base">Send detected bugs to the Caelo team</CardTitle>
      <CardDescription class="max-w-3xl space-y-2">
        <span class="block">
          When the AI runs into a bug in Caelo itself, the report can go straight to the Caelo team so
          it gets fixed. You don't need an account anywhere.
        </span>
        <span class="block">
          <strong>Sent:</strong> the report's title, what happened, what was expected, an excerpt of the
          evidence, the tool involved and your Caelo version. Email addresses, links, phone numbers and
          keys are removed first. <strong>Never sent:</strong> your pages, your chats, your site's address.
          Open a report and choose "What gets sent" to see the exact content.
        </span>
      </CardDescription>
    </CardHeader>
    <CardContent class="flex flex-wrap items-center gap-3">
      {#if forwarding.enabled}
        <span class="text-sm">
          <strong>On.</strong>
          <!-- "not sent" is the same number as the button below; reports
               marked fixed or invalid are never sent and are named apart. -->
          {forwarding.counts.sent} sent · {forwarding.counts.queued} waiting{forwarding.counts.unsent > 0
            ? ` · ${forwarding.counts.unsent} not sent`
            : ""}{forwarding.counts.closedUnsent > 0
            ? `. ${forwarding.counts.closedUnsent} marked fixed or invalid ${forwarding.counts.closedUnsent === 1 ? "stays" : "stay"} on this site.`
            : ""}
        </span>
        <!-- Covers reports filed before the opt-in and reports whose sending
             failed: both have not reached the Caelo team, one click sends them. -->
        {#if forwarding.counts.unsent > 0}
          <form method="post" action="?/queueUnsent">
            <input type="hidden" name="_csrf" value={data.csrfToken} />
            <Button type="submit" size="sm">
              <Send class="mr-2 size-4" /> Send {forwarding.counts.unsent} unsent report{forwarding
                .counts.unsent === 1
                ? ""
                : "s"}
            </Button>
          </form>
        {/if}
        <form method="post" action="?/setForwarding">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <input type="hidden" name="enabled" value="0" />
          <Button type="submit" size="sm" variant="outline">Stop sending</Button>
        </form>
      {:else}
        <form method="post" action="?/setForwarding">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <input type="hidden" name="enabled" value="1" />
          <Button type="submit" size="sm"><Send class="mr-2 size-4" /> Send bugs to Caelo</Button>
        </form>
        {#if forwarding.decidedAt === null}
          <form method="post" action="?/setForwarding">
            <input type="hidden" name="_csrf" value={data.csrfToken} />
            <input type="hidden" name="enabled" value="0" />
            <Button type="submit" size="sm" variant="outline">Keep them on this site</Button>
          </form>
        {:else}
          <span class="text-sm text-muted-foreground">
            Off. Reports stay on this site; use the export above to send them yourself.
          </span>
        {/if}
      {/if}
    </CardContent>
  </Card>

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
            <th class="px-4 py-2 font-medium">Source</th>
            <th class="px-4 py-2 font-medium">Severity</th>
            <th class="px-4 py-2 font-medium">Status</th>
            <th class="px-4 py-2 font-medium">Caelo team</th>
            <th class="px-4 py-2 font-medium">Suspected tool</th>
            <th class="px-4 py-2 font-medium">When</th>
          </tr>
        </thead>
        <tbody>
          {#each reports as r (r.id)}
            <tr
              class="cursor-pointer border-b last:border-0 hover:bg-muted/30 focus-visible:bg-muted/40 focus-visible:outline-none"
              role="button"
              tabindex="0"
              aria-expanded={!!expanded[r.id]}
              onclick={() => toggle(r.id)}
              onkeydown={onRowKey(r.id)}
            >
              <td class="px-4 py-2 font-medium">{r.title}</td>
              <td class="px-4 py-2">
                <span
                  class={cn(
                    "rounded px-1.5 py-0.5 text-xs font-medium",
                    r.source === "auto"
                      ? "bg-muted text-muted-foreground"
                      : "bg-primary/10 text-primary",
                  )}
                  title={r.source === "auto"
                    ? "Auto-captured from a failed tool result"
                    : "Filed by the AI via the bug_report tool"}
                >
                  {r.source === "auto" ? "auto" : "ai"}
                </span>
              </td>
              <td class="px-4 py-2">
                <span class={cn("rounded px-1.5 py-0.5 text-xs font-medium", severityClass(r.severity))}>
                  {r.severity}
                </span>
              </td>
              <td class="px-4 py-2 text-muted-foreground">{r.status}</td>
              <td
                class="px-4 py-2 whitespace-nowrap text-xs text-muted-foreground"
                title={r.forwardError ?? forwardingLabel[r.forwardingState].hint}
              >
                {upstreamLabel(r) ?? forwardingLabel[r.forwardingState].label}
              </td>
              <td class="px-4 py-2 font-mono text-xs text-muted-foreground">{r.suspectedTool ?? "—"}</td>
              <td class="px-4 py-2 whitespace-nowrap text-xs text-muted-foreground">
                {new Date(r.createdAt).toLocaleString()}
              </td>
            </tr>
            {#if expanded[r.id]}
              <tr class="border-b bg-muted/20 last:border-0">
                <td colspan="7" class="space-y-3 px-4 py-3 text-sm">
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
                  <div class="space-y-2">
                    <div class="text-xs font-semibold uppercase text-muted-foreground">Caelo team</div>
                    <p class="text-sm">
                      {upstreamLabel(r) ?? forwardingLabel[r.forwardingState].hint}
                      {#if r.upstreamIssueUrl}
                        <a
                          href={r.upstreamIssueUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          class="ml-1 inline-flex items-center gap-1 underline underline-offset-4"
                          onclick={(e) => e.stopPropagation()}
                        >
                          Public issue <ExternalLink class="size-3" />
                        </a>
                      {/if}
                    </p>
                    {#if r.forwardError}
                      <p class="text-xs text-destructive">{r.forwardError}</p>
                    {/if}
                    {#if previews[r.id]}
                      <pre class="overflow-x-auto rounded bg-muted p-2 text-xs">{previews[r.id]}</pre>
                    {:else}
                      <Button
                        variant="outline"
                        size="sm"
                        onclick={(e: MouseEvent) => {
                          e.stopPropagation();
                          void loadPreview(r.id);
                        }}
                      >
                        What gets sent
                      </Button>
                    {/if}
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
