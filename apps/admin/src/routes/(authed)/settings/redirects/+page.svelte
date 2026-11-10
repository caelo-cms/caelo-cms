<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P8 — the redirect editor. Auto-redirects from page renames, moves and
   * deletes land here too; every provider serves the live table at the edge
   * through the shared redirect plan (#587, @caelo-cms/shared).
   *
   * #1550 — redirects are draft state. Every rule shows its state: Live, or
   * the state of its pending change (Draft, Staged, Change staged, Removal
   * staged). A save changes nothing on the live site: Staged changes are
   * served by staging within seconds and go live with the next Publish live,
   * Drafts are served nowhere. Go live now is the one path past Publish
   * live, for someone with the Publish live permission. Every rule is paged
   * by cursor with a total and a server-side search (#1540).
   *
   * #1358 — a target on another domain takes an approver's click; the
   * queue shows what the AI proposed (and its Go live now proposals).
   */

  import { confirmSubmit } from "#lib/confirm.svelte.js";
  import { Trash2 } from "lucide-svelte";
  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button, buttonVariants } from "#lib/components/ui/button/index.js";
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
  import { cn } from "#lib/utils.js";

  let { data, form } = $props();

  type SyncTarget = (typeof data.syncTargets)[number];
  type Rule = (typeof data.rules)[number];

  /** One short state per production target, in the operator's words. */
  function stateOf(t: SyncTarget): { label: string; tone: "ok" | "warn" | "error" | "muted" } {
    if (!t.inSync) {
      return t.lastError
        ? { label: "Not on your hosting — push failed", tone: "error" }
        : { label: "Going to your hosting…", tone: "warn" };
    }
    if (!t.live) return { label: "Nothing published yet", tone: "muted" };
    return { label: "Up to date", tone: "ok" };
  }

  const waitingIds = $derived(new Map(data.waiting.map((w) => [w.id, w.reason])));

  /** The badges of a rule: its live state and the state of its pending change. */
  function badgesOf(r: Rule): { label: string; tone: "live" | "staged" | "draft" | "wait" }[] {
    const out: { label: string; tone: "live" | "staged" | "draft" | "wait" }[] = [];
    const c = r.change;
    if (r.live) out.push({ label: "Live", tone: "live" });
    if (c) {
      const staged = c.state === "staged";
      if (c.kind === "create") out.push({ label: staged ? "Staged" : "Draft", tone: c.state });
      if (c.kind === "change") {
        out.push({ label: staged ? "Change staged" : "Change in draft", tone: c.state });
      }
      if (c.kind === "remove") {
        out.push({ label: staged ? "Removal staged" : "Removal in draft", tone: c.state });
      }
      const waits = waitingIds.get(c.id);
      if (waits) {
        out.push({
          label: waits === "page" ? "Waiting for its page" : "Waiting for its target",
          tone: "wait",
        });
      }
    }
    return out;
  }

  const ORIGINS: Record<string, string> = {
    page_move: "a page rename or move",
    page_delete: "a page delete",
    url_migration: "a URL migration",
    revert: "a revert",
    plugin: "a plugin",
  };

  /** Why Go live now is not offered for this change, or null. */
  function goLiveRefusal(r: Rule): string | null {
    const c = r.change;
    if (!c) return null;
    if (!data.liveSite) return "Nothing is live yet: the first Publish live puts your site live.";
    if (c.origin !== "manual") {
      return `Caused by ${ORIGINS[c.origin] ?? c.origin}: it goes live with the Publish live that ships that change.`;
    }
    if (c.isolated) return "Saved in an experiment chat: it joins your site when that chat is staged.";
    if (waitingIds.has(c.id) && c.kind !== "remove") {
      return "Its target is not on your live site yet: it goes live with the Publish live that ships it.";
    }
    return null;
  }

  function filterHref(state: string): string {
    const params = new URLSearchParams();
    if (data.query) params.set("q", data.query);
    if (state !== "all") params.set("state", state);
    const qs = params.toString();
    return qs ? `?${qs}` : "?";
  }

  function nextHref(): string {
    const params = new URLSearchParams();
    if (data.query) params.set("q", data.query);
    if (data.state !== "all") params.set("state", data.state);
    if (data.nextCursor) params.set("cursor", data.nextCursor);
    return `?${params.toString()}`;
  }

  const offerNow = $derived(data.canGoLive && data.liveSite);

  const FILTERS: readonly (readonly [string, string])[] = [
    ["all", "All"],
    ["staged", "Staged"],
    ["draft", "Draft"],
  ];
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Redirects</h1>
    <p class="text-sm text-muted-foreground">
      A redirect sends an old address to a new one. Page renames, moves and deletes add them for you.
      A saved change is Staged: your staging site serves it within seconds, your live site with the
      next Publish live. A draft is served nowhere until you include it. A published page always wins
      over a redirect on its own address.
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
          Changes the AI asked for that need your approval. Nothing changes until you approve.
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        {#each data.proposals as p (p.id)}
          {@const mayApprove = p.kind === "go_live_now" ? data.canApproveGoLive : data.canApproveExternal}
          <div class="space-y-2 rounded-md border p-3" data-testid="redirect-proposal" data-kind={p.kind}>
            {#if p.kind === "go_live_now"}
              <p class="text-sm font-medium">Go live now, without Publish live</p>
              {#each p.payload.fromPaths ?? [] as path (path)}
                <p class="break-all font-mono text-sm">{path}</p>
              {/each}
            {:else}
              <p class="text-sm font-medium">
                {p.payload.goLive === "now"
                  ? "To another website, live at once"
                  : "To another website, with the next Publish live"}
              </p>
              {#each p.payload.redirects ?? [] as r (r.fromPath)}
                <p class="break-all font-mono text-sm">{r.fromPath} → {r.url} ({r.statusCode})</p>
              {/each}
            {/if}
            <div class="flex gap-2">
              <form method="post" action="?/approve">
                <input type="hidden" name="_csrf" value={data.csrfToken} />
                <input type="hidden" name="proposalId" value={p.id} />
                <Button
                  type="submit"
                  size="sm"
                  disabled={!mayApprove}
                  title={mayApprove ? undefined : "Approving this needs a permission your role does not have."}
                >
                  Approve
                </Button>
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
      <CardTitle class="text-base">Your live hosting</CardTitle>
      <CardDescription>
        The live redirects reach your hosting with each Publish live and each Go live now.
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
        </div>
      {/each}
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Rules</CardTitle>
      <CardDescription data-testid="redirect-total">
        {data.totalCount === 1 ? "1 rule" : `${data.totalCount} rules`}{data.query
          ? ` matching “${data.query}”`
          : ""}.
        {#if data.releaseProblem}
          Whether a Staged change waits for its target shows once the staged build can be read: {data.releaseProblem}
        {/if}
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-4">
      <div class="flex flex-wrap items-end gap-3">
        <form method="get" class="flex items-end gap-2" data-testid="redirect-search">
          {#if data.state !== "all"}<input type="hidden" name="state" value={data.state} />{/if}
          <div class="space-y-1">
            <Label for="q">Search</Label>
            <Input id="q" name="q" value={data.query} placeholder="/old or /new" class="w-64" />
          </div>
          <Button type="submit" size="sm" variant="outline">Search</Button>
        </form>
        <nav class="flex gap-1" aria-label="Filter rules" data-testid="redirect-filters">
          {#each FILTERS as [value, label] (value)}
            <a
              href={filterHref(value)}
              class={cn(buttonVariants({ variant: data.state === value ? "secondary" : "ghost", size: "sm" }))}
              aria-current={data.state === value ? "page" : undefined}>{label}</a
            >
          {/each}
        </nav>
      </div>

      {#if data.rules.length === 0}
        <p class="text-sm text-muted-foreground">
          {data.query || data.state !== "all" ? "No rule matches." : "No redirects yet."}
        </p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>From</TableHead>
              <TableHead>To</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>State</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.rules as r (r.address)}
              {@const c = r.change}
              {@const refusal = goLiveRefusal(r)}
              <TableRow data-testid="redirect-rule" data-from={r.fromPath}>
                <TableCell class="font-mono text-xs">{r.fromPath}</TableCell>
                <TableCell class="font-mono text-xs">
                  {#if c && c.kind === "change" && r.live}
                    <span class="text-muted-foreground line-through">{r.live.toPath}</span>
                  {/if}
                  {r.toPath}
                </TableCell>
                <TableCell>{r.statusCode}</TableCell>
                <TableCell>
                  <div class="flex flex-wrap gap-1" data-testid="redirect-state">
                    {#each badgesOf(r) as b (b.label)}
                      <Badge
                        variant={b.tone === "live" ? "secondary" : b.tone === "staged" ? "default" : "outline"}
                        >{b.label}</Badge
                      >
                    {/each}
                  </div>
                  {#if c && c.origin !== "manual"}
                    <p class="mt-1 text-xs text-muted-foreground">From {ORIGINS[c.origin] ?? c.origin}</p>
                  {/if}
                </TableCell>
                <TableCell>
                  {#if data.canWrite}
                    <div class="flex flex-wrap justify-end gap-1">
                      {#if c}
                        {#if c.state === "draft"}
                          <form method="post" action="?/include">
                            <input type="hidden" name="_csrf" value={data.csrfToken} />
                            <input type="hidden" name="fromPath" value={c.fromPath} />
                            <Button type="submit" size="sm" variant="outline">Include in next publish</Button>
                          </form>
                        {:else if c.origin === "manual"}
                          <form method="post" action="?/keepAsDraft">
                            <input type="hidden" name="_csrf" value={data.csrfToken} />
                            <input type="hidden" name="fromPath" value={c.fromPath} />
                            <Button type="submit" size="sm" variant="outline">Keep as draft</Button>
                          </form>
                        {/if}
                        {#if data.canGoLive}
                          <form method="post" action="?/goLive" use:confirmSubmit={{ title: `Put ${c.fromPath} live now?`, description: "It goes live on your site right away, without Publish live.", confirmLabel: "Go live now" }}>
                            <input type="hidden" name="_csrf" value={data.csrfToken} />
                            <input type="hidden" name="fromPath" value={c.fromPath} />
                            <Button
                              type="submit"
                              size="sm"
                              variant="outline"
                              disabled={refusal !== null}
                              title={refusal ?? undefined}
                              data-testid="redirect-go-live">Go live now</Button
                            >
                          </form>
                        {/if}
                        <form method="post" action="?/discard">
                          <input type="hidden" name="_csrf" value={data.csrfToken} />
                          <input type="hidden" name="fromPath" value={c.fromPath} />
                          <Button type="submit" size="sm" variant="ghost">Discard change</Button>
                        </form>
                      {:else}
                        <form method="post" action="?/delete" use:confirmSubmit={{ title: `Delete the redirect from ${r.fromPath}?`, description: `Staging stops forwarding ${r.fromPath} to ${r.toPath} now, your live site with the next Publish live.`, confirmLabel: "Delete redirect" }}>
                          <input type="hidden" name="_csrf" value={data.csrfToken} />
                          <input type="hidden" name="redirectId" value={r.id} />
                          <Button type="submit" size="sm" variant="ghost" aria-label="Delete">
                            <Trash2 class="size-3.5" />
                          </Button>
                        </form>
                      {/if}
                    </div>
                    {#if refusal && data.canGoLive}
                      <p class="mt-1 text-right text-xs text-muted-foreground" data-testid="redirect-go-live-reason">{refusal}</p>
                    {/if}
                  {/if}
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
        <div class="flex gap-2">
          {#if data.nextCursor}
            <a href={nextHref()} class={buttonVariants({ variant: "outline", size: "sm" })} data-testid="redirect-next-page"
              >Next page</a
            >
          {/if}
          {#if data.nextCursor || data.rules.length < data.totalCount}
            <a href={filterHref(data.state)} class={buttonVariants({ variant: "ghost", size: "sm" })}>First page</a>
          {/if}
        </div>
      {/if}
    </CardContent>
  </Card>

  {#if data.canWrite}
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
          <fieldset class="space-y-2 md:col-span-4" data-testid="redirect-go-live-choice">
            <legend class="text-sm font-medium">When it goes live</legend>
            <label class="flex items-center gap-2 text-sm">
              <input type="radio" name="goLive" value="next_publish" checked />
              With the next Publish live
            </label>
            <label class="flex items-center gap-2 text-sm">
              <input type="radio" name="goLive" value="later" />
              Later, keep it as a draft
            </label>
            {#if offerNow}
              <label class="flex items-center gap-2 text-sm">
                <input type="radio" name="goLive" value="now" />
                Now, without Publish live
              </label>
            {/if}
          </fieldset>
          <div class="md:col-span-4">
            <Button type="submit">Add redirect</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  {/if}
</div>
