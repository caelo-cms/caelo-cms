<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P8 — manual redirect editor. Auto-redirects from change_page_slug
   * + delete_page (disposition: redirect) land here too. Editor +
   * Owner can manage; static-generator emits the table to
   * `_redirects.caddy` / `_redirects` / `_redirects.cloudflare`.
   */

  import { Trash2 } from "lucide-svelte";
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
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
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Redirects</h1>
    <p class="text-sm text-muted-foreground">
      Edge 301 / 302 mappings. Auto-created by slug changes + page deletes; this view lets you add
      manual ones. Emitted to <code class="font-mono">_redirects.caddy</code>,
      <code class="font-mono">_redirects</code> (Netlify / Cloudflare Pages), and the SvelteKit
      hooks-server fallback.
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>{form.message ?? "Saved."}</AlertDescription></Alert>
  {/if}

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
                  <form method="post" action="?/delete">
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
      <CardDescription>Both paths must start with <code class="font-mono">/</code>.</CardDescription>
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
            <option value="301" selected>301 (permanent)</option>
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
