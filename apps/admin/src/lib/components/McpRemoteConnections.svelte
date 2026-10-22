<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  //
  // Issue #806 — Settings → MCP "Remote connections": one row per (user,
  // surface) that reached the site through a remote MCP client (claude.ai,
  // ChatGPT, Claude Code over HTTP, …). Rows appear on a user's first remote
  // request; the Owner revokes (sticky), restores, and sets the AI cost cap
  // (+ "may use Caelo's AI" on the admin surface). The guided setup that
  // turns remote MCP on lives elsewhere (#806 PR D).
  import { confirmSubmit } from "#lib/confirm.svelte.js";
  import type { McpRemoteConnectionRow } from "@caelo-cms/admin-core";
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
    csrfToken,
    canWrite,
  }: {
    connections: McpRemoteConnectionRow[];
    csrfToken: string;
    /** settings.write — revoke / restore / cap; readers see the list only. */
    canWrite: boolean;
  } = $props();

  function fmtUsdMc(mc: number | null): string {
    if (mc === null) return "uncapped";
    return `$${(mc / 1e8).toFixed(2)}`;
  }
</script>

<Card data-testid="mcp-remote-connections">
  <CardHeader>
    <CardTitle class="text-base">Remote connections</CardTitle>
    <CardDescription>
      People who connected an MCP client over the internet (claude.ai, ChatGPT, Claude Code, Cursor,
      …) with their own Google sign-in — no token involved. One row per person and surface: "chat"
      talks to Caelo's AI, "admin" drives the full tool catalogue. Revoke blocks that person's remote
      access until you restore it; their Caelo account is not affected.
    </CardDescription>
  </CardHeader>
  <CardContent>
    {#if connections.length === 0}
      <p class="text-sm text-muted-foreground">
        No remote connections yet. A row appears the first time someone connects remotely.
      </p>
    {:else}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Surface</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead>Cap / AI work</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each connections as c (c.id)}
            <TableRow data-testid="mcp-remote-row">
              <TableCell>
                <div>{c.email ?? c.actorId}</div>
                {#if c.clientLabel}
                  <div class="text-xs text-muted-foreground">{c.clientLabel}</div>
                {/if}
              </TableCell>
              <TableCell>
                <Badge variant={c.surface === "admin" ? "default" : "secondary"}>{c.surface}</Badge>
              </TableCell>
              <TableCell>
                {#if c.revokedAt}
                  <Badge variant="destructive">revoked</Badge>
                {:else}
                  <Badge variant="success">active</Badge>
                {/if}
              </TableCell>
              <TableCell class="text-xs">{c.lastUsedAt ?? "never"}</TableCell>
              <TableCell class="text-xs">
                {#if canWrite}
                  <form method="post" action="?/remoteSetCap" class="flex flex-wrap items-center gap-2">
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
                    <form method="post" action="?/remoteRevoke" use:confirmSubmit={{ title: `Revoke the connection of ${c.email ?? c.actorId}?`, description: "The connected agent loses access immediately. You can restore it later from this list.", confirmLabel: "Revoke" }}>
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
  </CardContent>
</Card>
