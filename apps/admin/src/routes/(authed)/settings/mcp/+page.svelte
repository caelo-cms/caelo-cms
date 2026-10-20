<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import McpClientSetup from "#lib/components/McpClientSetup.svelte";
  import McpRemoteConnections from "#lib/components/McpRemoteConnections.svelte";
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

  let { data, form } = $props();
  // #741 — "may use Caelo's AI" only exists for admin (Power-MCP) tokens.
  let newScope = $state<"chat" | "admin">("chat");

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

  const setupArgs = $derived(
    form?.ok && form?.plaintextToken
      ? {
          scope: String(form?.scope ?? ""),
          adminUrl: data.adminUrl,
          token: form.plaintextToken,
          iapServiceAccount: data.iapServiceAccount,
        }
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
      queue for your click. Each token acts as the user who minted it in audit + cost dashboards.
    </p>
  </div>

  <Card data-testid="mcp-remote-entry">
    <CardHeader>
      <CardTitle class="text-base">Connect ChatGPT, claude.ai and other AI tools</CardTitle>
      <CardDescription>
        Remote MCP: AI tools connect by URL and each person signs in with Google — no token, nothing
        to install. Set up once per site.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <a href="/settings/mcp/remote" class={buttonVariants({ variant: "outline" })}>
        Set up remote MCP
      </a>
    </CardContent>
  </Card>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok && form?.plaintextToken && setupArgs}
    <Alert>
      <AlertDescription class="space-y-4">
        <div class="space-y-2">
          <p class="font-medium">Token created — copy it now. It will never be shown again.</p>
          <pre class="overflow-x-auto rounded-md bg-muted p-3 text-xs"><code>{form.plaintextToken}</code></pre>
        </div>
        <McpClientSetup args={setupArgs} />
      </AlertDescription>
    </Alert>
  {/if}
  {#if form?.ok && form?.revoked}
    <Alert><AlertDescription>Token revoked.</AlertDescription></Alert>
  {/if}
  {#if form && "remoteUpdated" in form}
    <Alert><AlertDescription>Remote connection updated.</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">
        {data.visibility === "all" ? "Existing tokens" : "Your tokens"}
      </CardTitle>
      <CardDescription>
        {#if data.visibility === "all"}
          Every user's tokens. Revoke takes effect immediately. Expired tokens stop authenticating;
          mint a fresh one when a token is about to expire.
        {:else}
          Only your own tokens are shown. Revoke takes effect immediately. An Owner mints new tokens
          and manages other users' tokens.
        {/if}
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.tokens.length === 0}
        <p class="text-sm text-muted-foreground">
          {data.visibility === "all"
            ? "No tokens yet. Mint one below."
            : "You have no MCP tokens. Ask an Owner to mint one for you."}
        </p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Cap</TableHead>
              <TableHead>AI work</TableHead>
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
                <TableCell class="text-xs">
                  {#if t.scope === "chat"}
                    Caelo's AI
                  {:else if t.allowCaeloAi}
                    agent + Caelo's AI
                  {:else}
                    agent only
                  {/if}
                </TableCell>
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

  <McpRemoteConnections
    connections={data.remoteConnections}
    csrfToken={data.csrfToken}
    canWrite={data.canWrite}
  />

  {#if data.visibility === "all"}
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
            <Select id="scope" name="scope" bind:value={newScope}>
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
          {#if newScope === "admin"}
            <div class="flex items-start gap-2 md:col-span-4">
              <input
                id="allowCaeloAi"
                name="allowCaeloAi"
                type="checkbox"
                value="on"
                class="mt-1 size-4 accent-primary"
              />
              <div class="space-y-1">
                <Label for="allowCaeloAi">Agent may use Caelo's AI</Label>
                <p class="text-xs text-muted-foreground">
                  Off (recommended): the connected agent does all AI work on its own subscription —
                  translations, module authoring, page extraction come back to it as work items, and
                  image generation is unavailable (it uploads its own images). On: it may also run
                  image generation and translations on this install's AI, billed here and limited by the
                  cap above.
                </p>
              </div>
            </div>
          {/if}
        </form>
      </CardContent>
    </Card>
  {/if}
</div>
