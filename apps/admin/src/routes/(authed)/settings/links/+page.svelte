<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Epic #724 rollout E — internal links. Links between pages are stored
   * as references to the page, so renaming or moving a page never breaks
   * them. Content written before that was converted once when the admin
   * started after the update; this page shows that run's report and lets
   * the Owner re-run (or dry-run) and revert it. The AI reads the same
   * report (get_link_migration_report) and fixes the listed links.
   */

  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "#lib/components/ui/table/index.js";

  let { data, form } = $props();

  const SURFACES: Record<string, string> = {
    module_html: "Module markup",
    module_field_defaults: "Layout header / footer content",
    content_values: "Page and shared content",
    structured_sets: "Menus and link lists",
    layout_html: "Layout page frame",
  };
  const KINDS: Record<string, string> = {
    "unknown-page-path": "No page has this address",
    "unknown-media": "No image or file has this address",
    "dangling-page-ref": "The page was deleted",
    "dangling-media-ref": "The file was deleted",
    "unsupported-link-form": "The ?query or #anchor cannot be stored",
    "unknown-file": "No file on the site has this address",
    "malformed-link-ref": "A broken internal reference",
  };
  const surfaceLabel = (s: string) =>
    SURFACES[s] ?? (s.startsWith("plugin:") ? `Plugin ${s.slice(7)}` : s);
  const total = (counts: Record<string, number>) =>
    Object.values(counts).reduce((a, b) => a + b, 0);
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Internal links</h1>
    <p class="text-sm text-muted-foreground">
      Links between your pages now point at the page itself, so renaming or moving a page never
      breaks them. Links written before this update were converted once, automatically. Links
      that match no page were left exactly as they were and are listed below — nothing was
      guessed. Ask the AI to fix them, or edit them yourself.
    </p>
  </div>

  {#if data.error}
    <Alert variant="destructive"><AlertDescription>{data.error}</AlertDescription></Alert>
  {/if}
  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
    {#if form.conflict}
      <form method="post" action="?/revert">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <input type="hidden" name="runId" value={form.runId} />
        <input type="hidden" name="skipConflicts" value="true" />
        <Button type="submit" variant="outline" size="sm">Revert the rest, keep the edited parts</Button>
      </form>
    {/if}
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>{form.message}</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">
        {data.run?.mode === "dry_run" ? "Latest check (dry run)" : "Latest conversion"}
      </CardTitle>
      {#if data.run}
        <CardDescription>
          {data.run.mode === "dry_run" ? "Dry run (nothing changed)" : "Applied"},
          {new Date(data.run.createdAt).toLocaleString()}
          {#if data.run.revertedAt}— reverted {new Date(data.run.revertedAt).toLocaleString()}{/if}
        </CardDescription>
      {/if}
    </CardHeader>
    <CardContent class="space-y-4">
      {#if !data.run}
        <p class="text-sm text-muted-foreground">
          The conversion has not run yet. It runs once when the admin starts after the update.
        </p>
      {:else}
        <p class="text-sm">
          {total(data.run.counts)} link(s) converted{#if Object.keys(data.run.counts).length > 0}:
            {Object.entries(data.run.counts)
              .map(([s, n]) => `${surfaceLabel(s)} ${n}`)
              .join(" · ")}{/if}. {data.run.unresolvedCount} could not be converted.
        </p>
      {/if}
      <div class="flex flex-wrap gap-2">
        <form method="post" action="?/run">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <input type="hidden" name="dryRun" value="true" />
          <Button type="submit" variant="outline" size="sm">Check again (dry run)</Button>
        </form>
        <form method="post" action="?/run">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <input type="hidden" name="dryRun" value="false" />
          <Button type="submit" size="sm">Convert now</Button>
        </form>
        {#if data.revertableRun}
          <form method="post" action="?/revert">
            <input type="hidden" name="_csrf" value={data.csrfToken} />
            <input type="hidden" name="runId" value={data.revertableRun.runId} />
            <Button type="submit" variant="destructive" size="sm">
              Revert the conversion of {new Date(data.revertableRun.createdAt).toLocaleString()}
            </Button>
          </form>
        {/if}
      </div>
    </CardContent>
  </Card>

  {#if data.run && data.unresolvedTotal > 0}
    <Card>
      <CardHeader>
        <CardTitle class="text-base">Links that could not be converted ({data.unresolvedTotal})</CardTitle>
        <CardDescription>They are stored exactly as before. Point each at an existing page, or remove it.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Link</TableHead>
              <TableHead>Where</TableHead>
              <TableHead>Why</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.unresolved as u, i (`${u.entityId}-${u.where}-${i}`)}
              <TableRow>
                <TableCell class="font-mono text-xs">{u.value}</TableCell>
                <TableCell class="text-xs">
                  {u.label}{#if u.branchId}<span class="text-muted-foreground"> (unstaged chat change)</span>{/if}
                </TableCell>
                <TableCell class="text-xs">{KINDS[u.kind] ?? u.kind}</TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
        {#if data.unresolved.length < data.unresolvedTotal}
          <p class="mt-2 text-xs text-muted-foreground">
            Showing {data.unresolved.length} of {data.unresolvedTotal}. Ask the AI for the full list.
          </p>
        {/if}
      </CardContent>
    </Card>
  {/if}

  {#if data.recentRuns.length > 1}
    <Card>
      <CardHeader><CardTitle class="text-base">Earlier runs</CardTitle></CardHeader>
      <CardContent>
        <ul class="space-y-1 text-sm">
          {#each data.recentRuns as r (r.runId)}
            <li>
              <a class="underline" href={`?run=${r.runId}`}>{new Date(r.createdAt).toLocaleString()}</a>
              — {r.mode === "dry_run" ? "dry run" : "applied"},
              {total(r.counts)} converted, {r.unresolvedCount} not
              {#if r.revertedAt}(reverted){/if}
            </li>
          {/each}
        </ul>
      </CardContent>
    </Card>
  {/if}
</div>
