<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Settings → Data imports (docs/data-imports.md): what was taken over
   * from another system, where each import stands, and Undo. Imports run
   * in the chat; a file uploaded here gets an id to hand to the AI.
   */

  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "#lib/components/ui/table/index.js";
  import { confirmSubmit } from "#lib/confirm.svelte.js";

  let { data, form } = $props();

  const STATE_LABEL: Record<string, string> = {
    draft: "Draft",
    "waiting-for-build": "Waits for the Stage build",
    staged: "On staging",
    live: "Live",
    "undo-pending": "Undo waits for Stage and Publish live",
    undone: "Undone",
    written: "Saved as pending changes",
  };
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Data imports</h1>
    <p class="text-sm text-muted-foreground">
      Data taken over from another system: comments, rating totals, redirects. Ask the AI in the
      chat to import them; it converts the old system's export and checks every row. Imported rows
      reach your site like any change: with the next Stage and Publish live.
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>{form.message}</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle>Imports</CardTitle>
      <CardDescription>Newest first. Undo takes a whole import back.</CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.imports.length === 0}
        <p class="text-sm text-muted-foreground">No data has been imported yet.</p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>What</TableHead>
              <TableHead>From</TableHead>
              <TableHead class="text-right">Rows</TableHead>
              <TableHead>State</TableHead>
              <TableHead>When</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.imports as i (i.importId)}
              <TableRow>
                <TableCell>{i.kind}</TableCell>
                <TableCell>{i.sourceLabel}</TableCell>
                <TableCell class="text-right tabular-nums">{i.itemCount}</TableCell>
                <TableCell><Badge variant="secondary">{STATE_LABEL[i.state] ?? i.state}</Badge></TableCell>
                <TableCell class="text-sm text-muted-foreground">
                  {i.createdAt.slice(0, 10)}{i.createdBy ? `, ${i.createdBy}` : ""}
                </TableCell>
                <TableCell class="text-right">
                  {#if i.state !== "undone" && i.state !== "undo-pending"}
                    <form
                      method="post"
                      action="?/undo"
                      use:confirmSubmit={{
                        title: `Undo this import of ${i.kind}?`,
                        description:
                          "Rows not on staging yet are removed now. Rows already on staging or live leave with the next Stage and Publish live.",
                        confirmLabel: "Undo import",
                      }}
                    >
                      <input type="hidden" name="_csrf" value={data.csrfToken} />
                      <input type="hidden" name="importId" value={i.importId} />
                      <Button type="submit" size="sm" variant="ghost">Undo</Button>
                    </form>
                  {/if}
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {/if}
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle>Upload a file</CardTitle>
      <CardDescription>
        A CSV, JSON Lines or JSON file of up to 10 MB, kept 7 days. You get an id to give the AI in
        the chat.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/upload" enctype="multipart/form-data" class="flex flex-wrap items-center gap-3">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <Input id="data-import-file" type="file" name="file" accept=".csv,.jsonl,.ndjson,.json,.txt" class="max-w-sm" />
        <Button type="submit">Upload</Button>
      </form>
    </CardContent>
  </Card>
</div>
