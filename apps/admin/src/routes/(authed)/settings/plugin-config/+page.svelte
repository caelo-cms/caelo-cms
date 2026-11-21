<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Epic #1644 (#1645) — Settings → Plugin settings: the plugins with
   * settings, and the approval queue of their gated fields.
   */

  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { Button, buttonVariants } from "#lib/components/ui/button/index.js";
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#lib/components/ui/card/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#lib/components/ui/table/index.js";

  let { data, form } = $props();
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Plugin settings</h1>
    <p class="text-sm text-muted-foreground">
      Settings of your active plugins. A few settings, such as cost limits, change in a chat only after you approve them here or on the
      card in the chat.
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>{form.message}</AlertDescription></Alert>
  {/if}

  {#if data.proposals.length > 0}
    <Card>
      <CardHeader>
        <CardTitle>Waiting for your approval</CardTitle>
        <CardDescription>Changes the AI proposed. Approve to save them; they reach your site with the next Stage and Publish live.</CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        {#each data.proposals as p (p.id)}
          <div class="space-y-2 rounded-md border p-3">
            <p class="text-sm font-medium">{p.preview.pluginSlug}</p>
            {#if p.preview.reason}<p class="text-sm text-muted-foreground">{p.preview.reason}</p>{/if}
            <Table>
              <TableHeader><TableRow><TableHead>Setting</TableHead><TableHead>Now</TableHead><TableHead>Proposed</TableHead></TableRow></TableHeader>
              <TableBody>
                {#each p.preview.changes ?? [] as c (c.path)}
                  <TableRow><TableCell>{c.label}</TableCell><TableCell class="font-mono text-xs">{JSON.stringify(c.before)}</TableCell><TableCell class="font-mono text-xs">{JSON.stringify(c.after)}</TableCell></TableRow>
                {/each}
              </TableBody>
            </Table>
            <div class="flex flex-wrap items-center gap-2">
              <form method="POST" action="?/approve">
                <input type="hidden" name="_csrf" value={data.csrfToken} />
                <input type="hidden" name="proposalId" value={p.id} />
                <Button type="submit" size="sm">Approve</Button>
              </form>
              <form method="POST" action="?/reject" class="flex items-center gap-2">
                <input type="hidden" name="_csrf" value={data.csrfToken} />
                <input type="hidden" name="proposalId" value={p.id} />
                <Input name="reason" class="h-8 max-w-64" placeholder="Reason (optional)" />
                <Button type="submit" size="sm" variant="outline">Reject</Button>
              </form>
            </div>
          </div>
        {/each}
      </CardContent>
    </Card>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle>Plugins with settings</CardTitle>
    </CardHeader>
    <CardContent>
      {#if data.plugins.length === 0}
        <p class="text-sm text-muted-foreground">No active plugin has settings.</p>
      {:else}
        <ul class="space-y-2">
          {#each data.plugins as p (p.slug)}
            <li class="flex items-center justify-between gap-2">
              <span class="text-sm">{p.slug} <span class="text-muted-foreground">{p.version}</span></span>
              <a class={buttonVariants({ variant: "outline", size: "sm" })} href={`/settings/plugin-config/${p.slug}`}>Open</a>
            </li>
          {/each}
        </ul>
      {/if}
    </CardContent>
  </Card>
</div>
