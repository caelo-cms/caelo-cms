<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  //
  // Issue #806/#968 — Settings → MCP "Connected apps": one row per (user,
  // surface, app) that reached the site by URL (claude.ai, ChatGPT, Claude
  // Code, …), grouped by person. Rows appear on an app's first request. The
  // Owner revokes one app (sticky; the person's other apps keep working),
  // restores it, sets its AI cost cap (+ "may use Caelo's AI" on the admin
  // surface), and can block every app of a person, new ones included.
  // Everyone else sees only their own apps, read-only.
  import { confirmSubmit } from "#lib/confirm.svelte.js";
  import type { McpRemoteAccessBlockRow, McpRemoteConnectionRow } from "@caelo-cms/admin-core";
  import { MCP_SURFACE_COPY } from "@caelo-cms/shared";
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

  let {
    connections,
    blocks,
    csrfToken,
    canWrite,
  }: {
    connections: McpRemoteConnectionRow[];
    blocks: McpRemoteAccessBlockRow[];
    csrfToken: string;
    /** settings.write — revoke / restore / cap / block; others see their own apps only. */
    canWrite: boolean;
  } = $props();

  interface Person {
    readonly actorId: string;
    readonly email: string;
    readonly block: McpRemoteAccessBlockRow | undefined;
    readonly apps: McpRemoteConnectionRow[];
  }

  // A blocked person stays listed even without apps, so the block can be lifted.
  const people = $derived.by((): Person[] => {
    const byActor = new Map<string, Person>();
    const person = (actorId: string, email: string | null): Person => {
      let p = byActor.get(actorId);
      if (!p) {
        p = {
          actorId,
          email: email ?? actorId,
          block: blocks.find((b) => b.actorId === actorId),
          apps: [],
        };
        byActor.set(actorId, p);
      }
      return p;
    };
    for (const c of connections) person(c.actorId, c.email).apps.push(c);
    for (const b of blocks) person(b.actorId, b.email);
    return [...byActor.values()];
  });

  function fmtUsdMc(mc: number | null): string {
    if (mc === null) return "uncapped";
    return `$${(mc / 1e8).toFixed(2)}`;
  }
  const day = (iso: string) => iso.slice(0, 10);
</script>

<Card data-testid="mcp-remote-connections">
  <CardHeader>
    <CardTitle class="text-base">{canWrite ? "Connected apps" : "Your connected apps"}</CardTitle>
    <CardDescription>
      {#if canWrite}
        Every AI tool someone connected by URL, one row per app and address. Revoking an app stops
        only that app; the person's other apps keep working. "Block all apps" stops every app of
        that person, including apps they connect later. Their Caelo account is not affected.
      {:else}
        The AI tools you connected by URL. An Owner can revoke an app or set its AI spending cap.
      {/if}
    </CardDescription>
  </CardHeader>
  <CardContent class="space-y-6">
    {#if people.length === 0}
      <p class="text-sm text-muted-foreground">
        No apps connected yet. One appears here the first time someone connects an AI tool by URL.
      </p>
    {/if}
    {#each people as p (p.actorId)}
      <section class="space-y-2" data-testid="mcp-remote-person" data-email={p.email}>
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="font-medium">{p.email}</h3>
          {#if p.block}
            <Badge variant="destructive">all apps blocked</Badge>
            <span class="text-xs text-muted-foreground">
              by {p.block.blockedBy ?? "an Owner"} on {day(p.block.blockedAt)}
            </span>
          {/if}
          {#if canWrite}
            {#if p.block}
              <form method="post" action="?/remoteUnblockUser" class="ml-auto">
                <input type="hidden" name="_csrf" value={csrfToken} />
                <input type="hidden" name="actorId" value={p.actorId} />
                <Button type="submit" variant="outline" size="sm">Unblock</Button>
              </form>
            {:else}
              <form
                method="post"
                action="?/remoteBlockUser"
                class="ml-auto"
                use:confirmSubmit={{
                  title: `Block every app of ${p.email}?`,
                  description:
                    "All of this person's connected apps lose access immediately, including apps they connect later. You can unblock them here.",
                  confirmLabel: "Block all apps",
                }}
              >
                <input type="hidden" name="_csrf" value={csrfToken} />
                <input type="hidden" name="actorId" value={p.actorId} />
                <Button type="submit" variant="destructive" size="sm">Block all apps</Button>
              </form>
            {/if}
          {/if}
        </div>
        {#if p.apps.length > 0}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>App</TableHead>
                <TableHead>Address</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Cap / AI work</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {#each p.apps as c (c.id)}
                <TableRow data-testid="mcp-remote-row">
                  <TableCell>
                    <div>{c.clientName}</div>
                    {#if c.clientLabel && c.clientLabel !== c.clientName}
                      <div class="text-xs text-muted-foreground">reports as {c.clientLabel}</div>
                    {/if}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={c.surface === "admin" ? "default" : "secondary"}
                      title={MCP_SURFACE_COPY[c.surface].title}
                    >
                      {c.surface}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {#if c.revokedAt}
                      <Badge variant="destructive">revoked</Badge>
                      <div class="text-xs text-muted-foreground">
                        by {c.revokedBy ?? "an Owner"} on {day(c.revokedAt)}
                      </div>
                    {:else if p.block}
                      <Badge variant="destructive">blocked</Badge>
                    {:else}
                      <Badge variant="success">active</Badge>
                    {/if}
                  </TableCell>
                  <TableCell class="text-xs">{c.lastUsedAt ? day(c.lastUsedAt) : "never"}</TableCell>
                  <TableCell class="text-xs">
                    {#if canWrite}
                      <form
                        method="post"
                        action="?/remoteSetCap"
                        class="flex flex-wrap items-center gap-2"
                      >
                        <input type="hidden" name="_csrf" value={csrfToken} />
                        <input type="hidden" name="id" value={c.id} />
                        <input type="hidden" name="surface" value={c.surface} />
                        <Input
                          name="aiCostCapMicrocents"
                          type="number"
                          min="0"
                          class="h-8 w-36"
                          aria-label="Cap in microcents (blank = uncapped)"
                          placeholder="uncapped"
                          value={c.aiCostCapMicrocents ?? ""}
                        />
                        {#if c.surface === "admin"}
                          <label class="flex items-center gap-1">
                            <input
                              type="checkbox"
                              name="allowCaeloAi"
                              value="on"
                              checked={c.allowCaeloAi}
                              class="size-4 accent-primary"
                            />
                            may use Caelo's AI
                          </label>
                        {/if}
                        <Button type="submit" variant="outline" size="sm">Save</Button>
                      </form>
                    {:else}
                      {fmtUsdMc(c.aiCostCapMicrocents)}
                      {#if c.surface === "admin"}
                        · {c.allowCaeloAi ? "agent + Caelo's AI" : "agent only"}
                      {/if}
                    {/if}
                  </TableCell>
                  <TableCell>
                    {#if canWrite}
                      {#if c.revokedAt}
                        <form method="post" action="?/remoteRestore">
                          <input type="hidden" name="_csrf" value={csrfToken} />
                          <input type="hidden" name="id" value={c.id} />
                          <Button type="submit" variant="outline" size="sm">Restore</Button>
                        </form>
                      {:else}
                        <form
                          method="post"
                          action="?/remoteRevoke"
                          use:confirmSubmit={{
                            title: `Revoke ${c.clientName} for ${p.email}?`,
                            description:
                              "This app loses access immediately; the person's other apps keep working. You can restore it later from this list.",
                            confirmLabel: "Revoke",
                          }}
                        >
                          <input type="hidden" name="_csrf" value={csrfToken} />
                          <input type="hidden" name="id" value={c.id} />
                          <Button type="submit" variant="destructive" size="sm">Revoke</Button>
                        </form>
                      {/if}
                    {/if}
                  </TableCell>
                </TableRow>
              {/each}
            </TableBody>
          </Table>
        {/if}
      </section>
    {/each}
  </CardContent>
</Card>
