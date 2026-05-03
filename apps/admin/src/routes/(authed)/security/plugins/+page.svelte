<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P11 — Owner registry + activation surface for plugins.
   * Tier 1 (auto-loaded, signed) and Tier 2 (AI-authored, sandboxed)
   * listed separately. Approve / Disable / Reject / Re-enable actions
   * live on rows.
   */

  import { Puzzle } from "lucide-svelte";
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

  function fmtTime(s: string | null): string {
    if (!s) return "—";
    return new Date(s).toLocaleString();
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <Puzzle class="size-6" />
      Plugins
    </h1>
    <p class="text-sm text-muted-foreground">
      Tier 1 (core) plugins ship with Caelo, are signed, and run in-process. Tier 2 plugins are AI-authored
      against the SDK, sandboxed in a Deno subprocess, and require Owner approval before they run.
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

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Tier 1 — Core plugins ({data.tier1.length})</CardTitle>
      <CardDescription>
        Audited, signed, in-process. Auto-loaded at host startup; manifest signature verified each time.
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.tier1.length === 0}
        <p class="text-sm text-muted-foreground">
          No Tier 1 plugins loaded yet. They'll appear here once the host loader (P11.5+) ports
          translation / SEO / media into <code>packages/plugins/&lt;slug&gt;/</code>.
        </p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Slug</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.tier1 as p (p.id)}
              <TableRow>
                <TableCell class="font-mono text-xs">{p.slug}</TableCell>
                <TableCell class="text-xs">{p.version}</TableCell>
                <TableCell>
                  <Badge variant={p.status === "active" ? "default" : "secondary"}>
                    {p.status}
                  </Badge>
                </TableCell>
                <TableCell class="font-mono text-xs">{p.sourcePath ?? "—"}</TableCell>
                <TableCell>
                  {#if p.status === "active"}
                    <form method="post" action="?/disable" use:enhance>
                      <input type="hidden" name="slug" value={p.slug} />
                      <Button type="submit" size="sm" variant="outline">Disable</Button>
                    </form>
                  {:else if p.status === "disabled"}
                    <span class="text-xs text-muted-foreground">disabled · re-enable via host restart</span>
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
      <CardTitle class="text-base">
        Tier 2 — Awaiting activation ({data.tier2AwaitingActivation.length})
      </CardTitle>
      <CardDescription>
        AI submitted these for your approval. Click Approve to provision the plugin's <code>cms_public</code>
        schema and start dispatching its operations. Click Reject to delete the row.
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.tier2AwaitingActivation.length === 0}
        <p class="text-sm text-muted-foreground">No plugins awaiting your approval.</p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Slug</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Submitted</TableHead>
              <TableHead>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.tier2AwaitingActivation as p (p.id)}
              <TableRow>
                <TableCell class="font-mono text-xs">{p.slug}</TableCell>
                <TableCell class="text-xs">{p.version}</TableCell>
                <TableCell class="text-xs text-muted-foreground">{fmtTime(p.createdAt)}</TableCell>
                <TableCell class="space-x-2">
                  <form method="post" action="?/activate" use:enhance class="inline">
                    <input type="hidden" name="slug" value={p.slug} />
                    <Button type="submit" size="sm">Approve</Button>
                  </form>
                  <form method="post" action="?/reject" use:enhance class="inline">
                    <input type="hidden" name="slug" value={p.slug} />
                    <Button type="submit" size="sm" variant="outline">Reject</Button>
                  </form>
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
      <CardTitle class="text-base">Tier 2 — Active ({data.tier2Active.length})</CardTitle>
      <CardDescription>Currently dispatching operations on public requests.</CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.tier2Active.length === 0}
        <p class="text-sm text-muted-foreground">No active Tier 2 plugins.</p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Slug</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Activated</TableHead>
              <TableHead>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.tier2Active as p (p.id)}
              <TableRow>
                <TableCell class="font-mono text-xs">{p.slug}</TableCell>
                <TableCell class="text-xs">{p.version}</TableCell>
                <TableCell class="text-xs text-muted-foreground">{fmtTime(p.activatedAt)}</TableCell>
                <TableCell>
                  <form method="post" action="?/disable" use:enhance>
                    <input type="hidden" name="slug" value={p.slug} />
                    <Button type="submit" size="sm" variant="outline">Disable</Button>
                  </form>
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
      <CardTitle class="text-base">Tier 2 — Validation failures ({data.tier2Failed.length})</CardTitle>
      <CardDescription>
        AI submitted these but the validator rejected forbidden patterns. Each entry shows the structured
        errors for the AI's auto-fix path.
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.tier2Failed.length === 0}
        <p class="text-sm text-muted-foreground">No validation failures.</p>
      {:else}
        {#each data.tier2Failed as p (p.id)}
          <details class="border-b py-3 last:border-b-0">
            <summary class="flex cursor-pointer items-center gap-2 text-sm">
              <span class="font-mono text-xs">{p.slug}</span>
              <span class="text-xs text-muted-foreground">v{p.version}</span>
              <Badge variant="secondary">{p.validationErrors.length} error{p.validationErrors.length === 1 ? "" : "s"}</Badge>
            </summary>
            <ul class="mt-2 list-disc space-y-1 pl-6 text-xs">
              {#each p.validationErrors as e, i (i)}
                <li>
                  <code class="text-red-700 dark:text-red-400">[{e.kind}]</code>
                  {e.hint}
                  {#if e.snippet}
                    <span class="text-muted-foreground">— near: <code>{e.snippet}</code></span>
                  {/if}
                </li>
              {/each}
            </ul>
            <div class="mt-3 flex gap-2">
              <form method="post" action="?/revalidate" use:enhance>
                <input type="hidden" name="slug" value={p.slug} />
                <Button type="submit" size="sm" variant="outline">Re-run validator</Button>
              </form>
              <form method="post" action="?/reject" use:enhance>
                <input type="hidden" name="slug" value={p.slug} />
                <Button type="submit" size="sm" variant="outline">Reject</Button>
              </form>
            </div>
          </details>
        {/each}
      {/if}
    </CardContent>
  </Card>

  {#if data.tier2Rejected.length > 0}
    <Card>
      <CardHeader>
        <CardTitle class="text-base">Tier 2 — Rejected ({data.tier2Rejected.length})</CardTitle>
        <CardDescription>
          Owner declined these submissions. Source + reason preserved so the AI can read its
          original draft, revise per the reason, and resubmit a new version.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Slug</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Rejected</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.tier2Rejected as p (p.id)}
              <TableRow>
                <TableCell class="font-mono text-xs">{p.slug}</TableCell>
                <TableCell class="text-xs">{p.version}</TableCell>
                <TableCell class="max-w-xs truncate text-xs">{p.rejectionReason ?? "—"}</TableCell>
                <TableCell class="text-xs text-muted-foreground">{fmtTime(p.rejectedAt)}</TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  {/if}

  {#if data.tier2Disabled.length > 0}
    <Card>
      <CardHeader>
        <CardTitle class="text-base">Tier 2 — Disabled ({data.tier2Disabled.length})</CardTitle>
        <CardDescription>Data preserved; operations are not dispatched.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Slug</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Disabled</TableHead>
              <TableHead>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.tier2Disabled as p (p.id)}
              <TableRow>
                <TableCell class="font-mono text-xs">{p.slug}</TableCell>
                <TableCell class="text-xs">{p.version}</TableCell>
                <TableCell class="text-xs text-muted-foreground">{fmtTime(p.disabledAt)}</TableCell>
                <TableCell>
                  <form method="post" action="?/activate" use:enhance>
                    <input type="hidden" name="slug" value={p.slug} />
                    <Button type="submit" size="sm">Re-enable</Button>
                  </form>
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  {/if}
</div>
