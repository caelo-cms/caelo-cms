<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Inbox } from "lucide-svelte";
  import { enhance } from "$app/forms";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/components/ui/table/index.js";

  let { data, form } = $props();

  function fmtTime(s: string): string {
    return new Date(s).toLocaleString();
  }

  function statusVariant(s: string): "default" | "secondary" | "outline" | "destructive" {
    if (s === "new") return "default";
    if (s === "read") return "secondary";
    if (s === "spam") return "destructive";
    return "outline";
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <Inbox class="size-6" />
      Form submissions
    </h1>
    <p class="text-sm text-muted-foreground">
      Visitor submissions through the <code>&lt;caelo-form&gt;</code> Web Component.
      Submissions land here at status <em>new</em>; mark read or archive when handled.
    </p>
  </div>

  {#if form?.error}
    <div class="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">
      {form.error}
    </div>
  {/if}
  {#if form?.ok}
    <div class="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-700 dark:bg-green-950 dark:text-green-300">
      {form.message}
    </div>
  {/if}
  {#if data.error}
    <div class="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">
      Failed to load submissions: {data.error}
    </div>
  {/if}

  <div class="flex gap-2">
    {#each ["all", "new", "read", "archived", "spam"] as status (status)}
      <a href={status === "all" ? "?" : `?status=${status}`}>
        <Badge variant={data.activeStatus === status ? "default" : "outline"} class="cursor-pointer">
          {status}
        </Badge>
      </a>
    {/each}
  </div>

  <Card>
    <CardHeader>
      <CardTitle>Inbox</CardTitle>
      <CardDescription>{data.submissions.length} shown</CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.submissions.length === 0}
        <p class="text-sm text-muted-foreground">No submissions in this view.</p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Form</TableHead>
              <TableHead>Submitted</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Data</TableHead>
              <TableHead class="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.submissions as s (s.id)}
              <TableRow>
                <TableCell class="font-medium">{s.form_slug}</TableCell>
                <TableCell class="whitespace-nowrap">{fmtTime(s.submitted_at)}</TableCell>
                <TableCell><Badge variant={statusVariant(s.status)}>{s.status}</Badge></TableCell>
                <TableCell><pre class="max-w-md overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(s.data, null, 2)}</pre></TableCell>
                <TableCell class="text-right">
                  <div class="flex justify-end gap-2">
                    {#if s.status === "new"}
                      <form method="post" action="?/markRead" use:enhance>
                        <input type="hidden" name="submissionId" value={s.id} />
                        <Button size="sm" variant="secondary" type="submit">Mark read</Button>
                      </form>
                    {/if}
                    {#if s.status !== "archived"}
                      <form method="post" action="?/archive" use:enhance>
                        <input type="hidden" name="submissionId" value={s.id} />
                        <Button size="sm" variant="outline" type="submit">Archive</Button>
                      </form>
                    {/if}
                  </div>
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {/if}
    </CardContent>
  </Card>
</div>
