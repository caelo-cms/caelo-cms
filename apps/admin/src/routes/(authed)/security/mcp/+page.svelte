<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Select } from "$lib/components/ui/select/index.js";
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/components/ui/table/index.js";

  let { data, form } = $props();

  function fmtUsdMc(mc: number | null): string {
    if (mc === null) return "uncapped";
    return `$${(mc / 1e8).toFixed(2)}`;
  }
  function rowStatus(t: { revokedAt: string | null; expiresAt: string }): string {
    if (t.revokedAt) return "revoked";
    if (new Date(t.expiresAt).getTime() < Date.now()) return "expired";
    return "active";
  }
  function rowVariant(s: string): "success" | "secondary" | "destructive" {
    if (s === "active") return "success";
    if (s === "expired") return "secondary";
    return "destructive";
  }

  // Admin-scoped tokens wire the Power-MCP binary (full tool catalogue,
  // external agent drives the loop); chat tokens wire the caelo_chat shim.
  // `claude mcp add` syntax: options first, the server command after `--`
  // (there is no --command flag in the Claude Code CLI).
  const claudeMcpAddSnippet = $derived(
    form?.ok && form?.plaintextToken
      ? form?.scope === "admin"
        ? `claude mcp add caelo-admin \\
  --env CAELO_ADMIN_URL=${data.adminUrl} \\
  --env CAELO_MCP_TOKEN=${form.plaintextToken} \\
  -- bunx --package @caelo-cms/mcp-server caelo-admin-mcp`
        : `claude mcp add caelo \\
  --env CAELO_ADMIN_URL=${data.adminUrl} \\
  --env CAELO_MCP_TOKEN=${form.plaintextToken} \\
  -- bunx @caelo-cms/mcp-server`
      : null,
  );
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">MCP tokens</h1>
    <p class="text-sm text-muted-foreground">
      Bearer tokens for the Caelo MCP servers. Mint one per "place I want to talk to my Caelo install
      from" — laptop terminal, CI, Claude Code in the IDE. Scope "chat" talks to Caelo's own AI
      (caelo_chat); scope "admin" exposes the full tool catalogue to an external agent (Power-MCP) —
      the agent's writes run as an AI actor on a preview branch, and approval-gated actions still
      queue for your click. Each token assumes your Owner identity in audit + cost dashboards.
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok && form?.plaintextToken}
    <Alert>
      <AlertDescription class="space-y-2">
        <p class="font-medium">Token created — copy it now. It will never be shown again.</p>
        <pre class="overflow-x-auto rounded-md bg-muted p-3 text-xs"><code>{form.plaintextToken}</code></pre>
        <p class="font-medium">Wire it into Claude Code:</p>
        <pre class="overflow-x-auto rounded-md bg-muted p-3 text-xs"><code>{claudeMcpAddSnippet}</code></pre>
      </AlertDescription>
    </Alert>
  {/if}
  {#if form?.ok && form?.revoked}
    <Alert><AlertDescription>Token revoked.</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Existing tokens</CardTitle>
      <CardDescription>
        Revoke takes effect immediately. Expired tokens stop authenticating; mint a fresh one when
        a token is about to expire.
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.tokens.length === 0}
        <p class="text-sm text-muted-foreground">No tokens yet. Mint one below.</p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Cap</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.tokens as t (t.id)}
              {@const status = rowStatus(t)}
              <TableRow>
                <TableCell>{t.displayName}</TableCell>
                <TableCell>
                  <Badge variant={t.scope === "admin" ? "default" : "secondary"}>{t.scope}</Badge>
                </TableCell>
                <TableCell><Badge variant={rowVariant(status)}>{status}</Badge></TableCell>
                <TableCell>{fmtUsdMc(t.aiCostCapMicrocents)}</TableCell>
                <TableCell class="text-xs">{t.lastUsedAt ?? "never"}</TableCell>
                <TableCell class="text-xs">{t.expiresAt.slice(0, 10)}</TableCell>
                <TableCell>
                  {#if status === "active"}
                    <form method="post" action="?/revoke">
                      <input type="hidden" name="_csrf" value={data.csrfToken} />
                      <input type="hidden" name="id" value={t.id} />
                      <Button type="submit" variant="destructive" size="sm">Revoke</Button>
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
      <CardTitle class="text-base">New token</CardTitle>
      <CardDescription>
        90-day expiry. Set a cap to bound the wallet impact of a leaked token; leave blank for the
        site-wide budget surface to gate spend.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/create" class="grid gap-4 md:grid-cols-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <div class="space-y-2">
          <Label for="displayName">Name</Label>
          <Input id="displayName" name="displayName" type="text" placeholder="claude-code" required />
        </div>
        <div class="space-y-2">
          <Label for="scope">Scope</Label>
          <Select id="scope" name="scope">
            <option value="chat">chat — talk to Caelo's AI (caelo_chat)</option>
            <option value="admin">admin — full tool catalogue (Power-MCP)</option>
          </Select>
        </div>
        <div class="space-y-2">
          <Label for="aiCostCapMicrocents">Cap (microcents)</Label>
          <Input
            id="aiCostCapMicrocents"
            name="aiCostCapMicrocents"
            type="number"
            min="0"
            placeholder="leave blank for uncapped"
          />
        </div>
        <div class="flex items-end">
          <Button type="submit">Create token</Button>
        </div>
      </form>
    </CardContent>
  </Card>
</div>
