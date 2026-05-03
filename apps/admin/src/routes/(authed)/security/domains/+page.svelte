<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { CheckCircle, Globe, ShieldAlert, ShieldQuestion, Trash2 } from "lucide-svelte";
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
  import { Input } from "$lib/components/ui/input/index.js";
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/components/ui/table/index.js";

  let { data, form } = $props();
  let kind = $state<"admin" | "public" | "locale-public">("public");
</script>

<div class="space-y-6">
  <div>
    <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <Globe class="size-6" />
      Domains &amp; SSL
    </h1>
    <p class="text-sm text-muted-foreground">
      Hostnames Caelo serves. <code>cms-provision regenerate-caddy</code> reads this table at deploy
      to emit Caddyfile vhosts + request Let's Encrypt certs. Per-locale URL routing (subdomain /
      separate domain) lives at <a href="/security/locales" class="underline">/security/locales</a>.
    </p>
  </div>

  {#if form?.error}
    <div class="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">{form.error}</div>
  {/if}
  {#if form?.ok}
    <div class="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-700 dark:bg-green-950 dark:text-green-300">{form.message}</div>
  {/if}
  {#if data.error}
    <div class="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">Could not load domains: {data.error}</div>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle>Add a domain</CardTitle>
      <CardDescription>
        Before adding, point the hostname's A record (or AAAA for IPv6) at this server's public IP. Caddy needs port 80 reachable for the ACME HTTP-01 challenge.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/add" use:enhance class="grid gap-3 max-w-xl md:grid-cols-3">
        <label class="grid gap-1 text-sm md:col-span-2">
          <span>Hostname</span>
          <Input name="hostname" placeholder="example.com" required />
        </label>
        <label class="grid gap-1 text-sm">
          <span>Kind</span>
          <select bind:value={kind} name="kind" class="rounded border px-3 py-2 text-sm">
            <option value="public">Public site</option>
            <option value="admin">Admin app</option>
            <option value="locale-public">Per-locale public site</option>
          </select>
        </label>
        {#if kind === "locale-public"}
          <label class="grid gap-1 text-sm md:col-span-3">
            <span>Locale code</span>
            <Input name="localeCode" placeholder="de" required />
          </label>
        {/if}
        <div class="md:col-span-3"><Button type="submit">Add</Button></div>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle>Configured domains</CardTitle>
      <CardDescription>{data.domains.length} total</CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.domains.length === 0}
        <p class="text-sm text-muted-foreground">No domains yet. Add one above.</p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Hostname</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>TLS</TableHead>
              <TableHead>Last checked</TableHead>
              <TableHead class="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.domains as d (d.id)}
              <TableRow>
                <TableCell class="font-mono text-xs">
                  <a href="https://{d.hostname}" target="_blank" rel="noopener noreferrer" class="underline">{d.hostname}</a>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{d.kind}</Badge>
                  {#if d.localeCode}<Badge>{d.localeCode}</Badge>{/if}
                </TableCell>
                <TableCell>
                  {#if d.tlsStatus === "active"}
                    <span class="inline-flex items-center gap-1 text-green-600"><CheckCircle class="size-3" /> active</span>
                    {#if d.tlsExpiresAt}<span class="ml-2 text-xs text-muted-foreground">expires {new Date(d.tlsExpiresAt).toLocaleDateString()}</span>{/if}
                  {:else if d.tlsStatus === "failed"}
                    <span class="inline-flex items-center gap-1 text-red-600"><ShieldAlert class="size-3" /> failed</span>
                    {#if d.tlsError}<span class="ml-2 text-xs text-muted-foreground">{d.tlsError.slice(0, 80)}</span>{/if}
                  {:else}
                    <span class="inline-flex items-center gap-1 text-muted-foreground"><ShieldQuestion class="size-3" /> {d.tlsStatus}</span>
                  {/if}
                </TableCell>
                <TableCell class="text-xs">{d.lastVerifiedAt ? new Date(d.lastVerifiedAt).toLocaleString() : "never"}</TableCell>
                <TableCell class="text-right">
                  <div class="flex justify-end gap-2">
                    <form method="post" action="?/verify" use:enhance>
                      <input type="hidden" name="domainId" value={d.id} />
                      <Button type="submit" size="sm" variant="secondary">Verify DNS</Button>
                    </form>
                    <form method="post" action="?/remove" use:enhance>
                      <input type="hidden" name="domainId" value={d.id} />
                      <Button type="submit" size="sm" variant="destructive"><Trash2 class="size-3" /></Button>
                    </form>
                  </div>
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
      <CardTitle>Required DNS records</CardTitle>
      <CardDescription>Apply at your DNS provider before adding the hostname.</CardDescription>
    </CardHeader>
    <CardContent class="space-y-2 text-sm">
      <p><code>A</code> record: <code>&lt;hostname&gt;</code> → public IP of this server.</p>
      <p><code>AAAA</code> record: <code>&lt;hostname&gt;</code> → IPv6 (optional but recommended).</p>
      <p><code>CAA</code> record: <code>&lt;hostname&gt;</code> → <code>0 issue "letsencrypt.org"</code> — restricts cert issuance to Let's Encrypt.</p>
      <p class="text-muted-foreground">After DNS propagates (verify above), Caddy auto-requests a cert on next reload.</p>
    </CardContent>
  </Card>
</div>
