<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Rocket } from "lucide-svelte";
  import { onDestroy, onMount } from "svelte";
  import EmptyStatePlaceholder from "$lib/components/EmptyStatePlaceholder.svelte";
  import { Badge, type BadgeVariant } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Progress } from "$lib/components/ui/progress/index.js";
  import { Select } from "$lib/components/ui/select/index.js";
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/components/ui/table/index.js";

  let { data } = $props();

  const statusVariant = (status: string): BadgeVariant => {
    if (status === "succeeded") return "success";
    if (status === "failed") return "destructive";
    if (status === "running") return "secondary";
    return "outline";
  };

  // P6.6b — live progress polling. While any run is in `running` or
  // `pending` state, refetch /api/deploy-runs every 1.5s and replace
  // `data.runs` so the Progress bar and status badges advance without
  // a manual reload. Polling stops when no in-flight rows remain.
  // Uses the Page Visibility API to pause in background tabs.
  let runs = $state(data.runs);
  let pollHandle: ReturnType<typeof setInterval> | null = null;
  const inFlight = $derived(
    runs.some((r: { status: string }) => r.status === "running" || r.status === "pending"),
  );

  async function refetch() {
    if (document.visibilityState !== "visible") return;
    try {
      const r = await fetch("/api/deploy-runs", { headers: { accept: "application/json" } });
      if (!r.ok) return;
      const json = (await r.json()) as { runs: typeof data.runs };
      runs = json.runs;
    } catch {
      // Network blip — ignore; the next tick retries.
    }
  }
  $effect(() => {
    // (Re)start the interval whenever inFlight transitions to true,
    // tear it down once everything's settled.
    if (inFlight && !pollHandle) {
      pollHandle = setInterval(refetch, 1_500);
    } else if (!inFlight && pollHandle) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  });
  onMount(() => {
    // Initial refetch right after mount picks up any run that was
    // already in flight when the page loaded.
    void refetch();
  });
  onDestroy(() => {
    if (pollHandle) clearInterval(pollHandle);
  });
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Deployments</h1>
    <p class="text-sm text-muted-foreground">
      Three-environment Ops view. Editors see only Publish; this page exposes the underlying flow.
    </p>
  </div>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Targets</CardTitle>
    </CardHeader>
    <CardContent>
      <ul class="space-y-2">
        {#each data.targets as t (t.id)}
          <li class="flex items-center gap-3 rounded-md border p-3">
            <strong>{t.name}</strong>
            <Badge variant="outline"><code>{t.env}</code></Badge>
            <span class="text-xs text-muted-foreground">
              out_dir={t.outDir} robots={t.robotsDefault}{t.isDefault ? " (default)" : ""}
            </span>
            <!-- Plain POST — refreshing after a build runs another
                 build, which is wasteful but not destructive. Keeping
                 it native so the page-level data.targets list (which
                 reads the "succeeded" status) refreshes correctly. -->
            <form method="post" action="?/trigger" class="ml-auto">
              <input type="hidden" name="_csrf" value={data.csrfToken} />
              <input type="hidden" name="targetName" value={t.name} />
              <Button type="submit" size="sm" variant="outline">Build {t.name}</Button>
            </form>
          </li>
        {/each}
      </ul>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Promote</CardTitle>
      <CardDescription>Atomic copy from one target's last build to another's current.</CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/promote" class="flex flex-wrap items-end gap-3">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <div class="space-y-1">
          <Label for="fromTarget">From</Label>
          <Select id="fromTarget" name="fromTarget" class="w-auto">
            {#each data.targets as t (t.id)}
              <option value={t.name}>{t.name}</option>
            {/each}
          </Select>
        </div>
        <div class="space-y-1">
          <Label for="toTarget">To</Label>
          <Select id="toTarget" name="toTarget" class="w-auto">
            {#each data.targets as t (t.id)}
              <option value={t.name}>{t.name}</option>
            {/each}
          </Select>
        </div>
        <Button type="submit">Promote</Button>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Recent runs</CardTitle>
    </CardHeader>
    <CardContent>
      {#if runs.length === 0}
        <EmptyStatePlaceholder
          icon={Rocket}
          title="No deploy runs yet"
          description="Trigger a build for staging or production from the Targets section above. Runs land here with progress + history."
        />
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Target</TableHead>
              <TableHead>Env</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Pages / files</TableHead>
              <TableHead>Progress</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each runs as r (r.id)}
              <TableRow>
                <TableCell><strong>{r.targetName}</strong></TableCell>
                <TableCell><code>{r.env}</code></TableCell>
                <TableCell>
                  <Badge variant={statusVariant(r.status)}>{r.targetName} {r.status}</Badge>
                </TableCell>
                <TableCell class="text-muted-foreground">
                  {r.startedAt.slice(0, 19).replace("T", " ")}
                </TableCell>
                <TableCell>
                  {#if r.pageCount !== null}
                    {r.pageCount} / {r.fileCount}
                  {:else}
                    —
                  {/if}
                </TableCell>
                <TableCell>
                  {#if r.progress && r.status === "running"}
                    <Progress value={r.progress.pagesDone} max={Math.max(1, r.progress.pagesTotal)} />
                  {/if}
                  {#if r.errorMessage}
                    <pre class="mt-1 max-w-xl whitespace-pre-wrap text-xs text-destructive">{r.errorMessage}</pre>
                  {/if}
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {/if}
    </CardContent>
  </Card>
</div>
