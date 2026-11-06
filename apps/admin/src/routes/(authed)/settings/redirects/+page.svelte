<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P8 — manual redirect editor. Auto-redirects from change_page_slug
   * + delete_page (disposition: redirect) land here too. Editor +
   * Owner can manage; every provider serves the table at the edge
   * through the shared redirect plan (#587, @caelo-cms/shared).
   * #1157 — a save puts the table live on the hosting right away (no
   * build); the "Live on your hosting" card shows each target's state
   * and a push that failed, with "Try again now" for that target.
   * #1358 — a target on another domain takes an approver's click: the
   * queue shows what the AI proposed, and the form applies one directly
   * for someone who may approve it.
   */

  import { confirmSubmit } from "#lib/confirm.svelte.js";
  import { Trash2 } from "lucide-svelte";
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
  import { Label } from "#lib/components/ui/label/index.js";
  import { Select } from "#lib/components/ui/select/index.js";
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "#lib/components/ui/table/index.js";

  let { data, form } = $props();

  type SyncTarget = (typeof data.syncTargets)[number];

  /** One short state per target, in the operator's words. */
  function stateOf(t: SyncTarget): { label: string; tone: "ok" | "warn" | "error" | "muted" } {
    if (!t.inSync) {
      return t.lastError
        ? { label: "Not live — push failed", tone: "error" }
        : { label: "Going live…", tone: "warn" };
    }
    if (t.last === null || t.last.status === "nothing-live") {
      return { label: "Nothing published yet", tone: "muted" };
    }
    if (t.last.status === "not-served") return { label: "No redirects on this host", tone: "muted" };
    return { label: "Live", tone: "ok" };
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Redirects</h1>
    <p class="text-sm text-muted-foreground">
      Edge 301 / 302 mappings. Auto-created by slug changes + page deletes; this view lets you add
      manual ones. Saving puts them live on your hosting right away, without a publish; they are
      answered before any page, except where a published page serves the same path.
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>{form.message ?? "Saved."}</AlertDescription></Alert>
  {/if}

  {#if data.proposals.length > 0}
    <Card data-testid="redirect-proposals">
      <CardHeader>
        <CardTitle class="text-base">Waiting for your decision</CardTitle>
        <CardDescription>
          Addresses the AI wants to send to another website. Nothing changes until you approve.
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        {#each data.proposals as p (p.id)}
          <div class="space-y-2 rounded-md border p-3" data-testid="redirect-proposal">
            {#each p.payload.redirects ?? [] as r (r.fromPath)}
              <p class="break-all font-mono text-sm">{r.fromPath} → {r.url} ({r.statusCode})</p>
            {/each}
            <div class="flex gap-2">
              <form method="post" action="?/approve">
                <input type="hidden" name="_csrf" value={data.csrfToken} />
                <input type="hidden" name="proposalId" value={p.id} />
                <Button type="submit" size="sm">Approve</Button>
              </form>
              <form method="post" action="?/reject">
                <input type="hidden" name="_csrf" value={data.csrfToken} />
                <input type="hidden" name="proposalId" value={p.id} />
                <Button type="submit" size="sm" variant="outline">Reject</Button>
              </form>
            </div>
          </div>
        {/each}
      </CardContent>
    </Card>
  {/if}

  <Card data-testid="redirect-sync-status">
    <CardHeader>
      <CardTitle class="text-base">Live on your hosting</CardTitle>
      <CardDescription>
        A redirect to a page that is not published yet answers 404 there until you Publish live.
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-3">
      {#each data.syncTargets as t (t.targetId)}
        {@const state = stateOf(t)}
        <div class="space-y-1 text-sm" data-testid="redirect-sync-target" data-env={t.env}>
          <div class="flex items-center gap-2">
            <span class="font-medium">{t.targetName}</span>
            <Badge
              variant={state.tone === "error"
                ? "destructive"
                : state.tone === "ok"
                  ? "secondary"
                  : "outline"}>{state.label}</Badge
            >
            {#if t.last && t.inSync && t.last.redirectCount !== null}
              <span class="text-muted-foreground">{t.last.redirectCount} served</span>
            {/if}
          </div>
          {#if !t.inSync && t.lastError}
            <p class="text-destructive">
              {t.lastError}
              {#if t.nextAttemptAt}
                <span class="text-muted-foreground">
                  Retried automatically at {new Date(t.nextAttemptAt).toLocaleTimeString()}.
                </span>
              {/if}
            </p>
          {/if}
          {#if !t.inSync}
            <!-- Per target: retrying one never retries another that is still backing off. -->
            <form method="post" action="?/sync">
              <input type="hidden" name="_csrf" value={data.csrfToken} />
              <input type="hidden" name="targetId" value={t.targetId} />
              <Button type="submit" size="sm" variant="outline">Try again now</Button>
            </form>
          {/if}
          {#if t.inSync && t.last && t.goneAnswer === 404 && (t.last.goneCount ?? 0) > 0}
            <!-- #1357 — this host cannot send a bare 410; a gone path gets its 404. -->
            <p class="text-muted-foreground" data-testid="redirect-sync-gone-as-404">
              {t.last.goneCount === 1 ? "1 rule" : `${t.last.goneCount} rules`} with 410 Gone answer 404
              on this hosting: it cannot send a 410.
            </p>
          {/if}
          {#if t.inSync && t.last && t.last.unservedTargets.length > 0}
            <p class="text-muted-foreground">
              Waiting for Publish live:
              <code class="font-mono text-xs"
                >{t.last.unservedTargets
                  .slice(0, 5)
                  .map((u) => `${u.fromPath} → ${u.location}`)
                  .join(", ")}</code
              >
              {#if t.last.unservedTargets.length > 5}
                and {t.last.unservedTargets.length - 5} more
              {/if}
            </p>
          {/if}
        </div>
      {/each}
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Existing</CardTitle>
    </CardHeader>
    <CardContent>
      {#if data.redirects.length === 0}
        <p class="text-sm text-muted-foreground">No redirects yet.</p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>From</TableHead>
              <TableHead>To</TableHead>
              <TableHead>Status</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.redirects as r (r.id)}
              <TableRow>
                <TableCell class="font-mono text-xs">{r.fromPath}</TableCell>
                <TableCell class="font-mono text-xs">{r.toPath}</TableCell>
                <TableCell>{r.statusCode}</TableCell>
                <TableCell>
                  <form method="post" action="?/delete" use:confirmSubmit={{ title: `Delete the redirect from ${r.fromPath}?`, description: `Links to ${r.fromPath} no longer forward to ${r.toPath}.`, confirmLabel: "Delete redirect" }}>
                    <input type="hidden" name="_csrf" value={data.csrfToken} />
                    <input type="hidden" name="redirectId" value={r.id} />
                    <Button type="submit" size="sm" variant="ghost" aria-label="Delete">
                      <Trash2 class="size-3.5" />
                    </Button>
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
      <CardTitle class="text-base">New redirect</CardTitle>
      <CardDescription>
        From is a path starting with <code class="font-mono">/</code>. To is a path, or a full
        <code class="font-mono">https://</code> address on another website, which needs permission
        to change site settings. Check that address: visitors land there under your domain's name.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/create" class="grid gap-4 md:grid-cols-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <div class="space-y-2 md:col-span-2">
          <Label for="fromPath">From</Label>
          <Input id="fromPath" name="fromPath" placeholder="/old" required />
        </div>
        <div class="space-y-2">
          <Label for="toPath">To</Label>
          <Input id="toPath" name="toPath" placeholder="/new" required />
        </div>
        <div class="space-y-2">
          <Label for="statusCode">Status</Label>
          <Select id="statusCode" name="statusCode">
            <option value="" selected>Automatic (301 on this site, 302 to another website)</option>
            <option value="301">301 (permanent)</option>
            <option value="302">302 (temporary)</option>
            <option value="307">307 (preserve method)</option>
            <option value="308">308 (preserve method, permanent)</option>
          </Select>
        </div>
        <div class="md:col-span-4">
          <Button type="submit">Add redirect</Button>
        </div>
      </form>
    </CardContent>
  </Card>
</div>
