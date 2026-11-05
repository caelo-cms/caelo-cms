<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Issue #1461 — the site's small data files (JSON, TXT, CSV, XML) at a
   * chosen address. Saving keeps a file in Caelo; it reaches the site with
   * the next Stage and Publish live, which is what each row's state shows.
   */

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
  import { Textarea } from "#lib/components/ui/textarea/index.js";
  import { confirmSubmit } from "#lib/confirm.svelte.js";

  let { data, form } = $props();

  const STATE_LABEL = {
    not_staged: "Not staged yet",
    staged: "On staging",
    live: "Live",
  } as const;

  let body = $state("");
  let readError = $state<string | null>(null);

  // A new edit link fills the form with that file's text.
  $effect(() => {
    body = data.editing?.body ?? "";
  });

  async function loadFile(event: Event): Promise<void> {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    readError = null;
    if (file.size > data.maxBytes) {
      readError = `${file.name} has ${file.size} bytes; a file may have at most ${data.maxBytes}.`;
      return;
    }
    body = await file.text();
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Static files</h1>
    <p class="text-sm text-muted-foreground">
      Small data files at an address of your choice, like <code class="font-mono">/bot/ips.json</code>
      or <code class="font-mono">/.well-known/security.txt</code>, served the way robots.txt is. A
      file reaches your site with the next Stage and Publish live. Because such a file can prove to
      another company that you own this domain, the AI only proposes them and you decide.
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>{form.message}</AlertDescription></Alert>
  {/if}

  {#if data.proposals.length > 0}
    <Card data-testid="static-file-proposals">
      <CardHeader>
        <CardTitle class="text-base">Waiting for your decision</CardTitle>
        <CardDescription>What the AI proposed. Nothing changes until you approve it.</CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        {#each data.proposals as p (p.id)}
          <div class="space-y-2 rounded-md border p-3" data-testid="static-file-proposal">
            {#if p.kind === "delete"}
              <p class="text-sm">Remove <code class="font-mono">{p.payload.paths?.join(", ")}</code></p>
            {:else}
              {#each p.payload.files ?? [] as f (f.path)}
                <div class="space-y-1">
                  <p class="text-sm">
                    <code class="font-mono">{f.path}</code>
                    <span class="text-muted-foreground">({f.contentType})</span>
                  </p>
                  <p class="text-sm text-muted-foreground">{f.purpose}</p>
                  <pre
                    class="max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap break-all">{f.body}</pre>
                </div>
              {/each}
            {/if}
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

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Files</CardTitle>
      <CardDescription>
        {data.files.length} of {data.maxCount}, each up to {data.maxBytes / 1024} KiB.
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.files.length === 0}
        <p class="text-sm text-muted-foreground">No static files yet.</p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Address</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Why it exists</TableHead>
              <TableHead>State</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.files as f (f.id)}
              <TableRow data-testid="static-file-row">
                <TableCell class="font-mono text-xs">{f.path}</TableCell>
                <TableCell class="text-xs">{f.contentType}</TableCell>
                <TableCell class="text-sm text-muted-foreground">{f.purpose}</TableCell>
                <TableCell>
                  <Badge variant={f.releaseState === "live" ? "secondary" : "outline"}>
                    {STATE_LABEL[f.releaseState]}
                  </Badge>
                </TableCell>
                <TableCell class="flex items-center gap-1">
                  <a
                    class={buttonVariants({ variant: "ghost", size: "sm" })}
                    href={`?edit=${encodeURIComponent(f.path)}`}>Edit</a
                  >
                  <form
                    method="post"
                    action="?/delete"
                    use:confirmSubmit={{
                      title: `Delete ${f.path}?`,
                      description:
                        "If another company checks this file to confirm you own the domain, that check fails once it is gone from the live site.",
                      confirmLabel: "Delete file",
                    }}
                  >
                    <input type="hidden" name="_csrf" value={data.csrfToken} />
                    <input type="hidden" name="path" value={f.path} />
                    <Button type="submit" size="sm" variant="ghost" aria-label={`Delete ${f.path}`}>
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
      <CardTitle class="text-base">{data.editing ? `Edit ${data.editing.path}` : "New file"}</CardTitle>
      <CardDescription>
        Paste the text or load it from your computer. Addresses end in .json, .txt, .csv, .xml or
        nothing. HTML, scripts, styles and SVG are not possible here.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/save" class="space-y-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <div class="grid gap-4 md:grid-cols-2">
          <div class="space-y-2">
            <Label for="path">Address</Label>
            <Input
              id="path"
              name="path"
              placeholder="/bot/ips.json"
              value={data.editing?.path ?? ""}
              readonly={data.editing !== null}
              required
            />
          </div>
          <div class="space-y-2">
            <Label for="contentType">Type</Label>
            <Select id="contentType" name="contentType" value={data.editing?.contentType}>
              {#each data.contentTypes as type (type)}
                <option value={type}>{type}</option>
              {/each}
            </Select>
          </div>
        </div>
        <div class="space-y-2">
          <Label for="purpose">Why it exists</Label>
          <Input
            id="purpose"
            name="purpose"
            placeholder="Who reads this file, and what for"
            value={data.editing?.purpose ?? ""}
            required
          />
        </div>
        <div class="space-y-2">
          <Label for="body">Content</Label>
          <Textarea id="body" name="body" rows={10} class="font-mono text-xs" bind:value={body} required />
          <input
            type="file"
            aria-label="Load from a file"
            class="text-sm"
            onchange={loadFile}
          />
          {#if readError}
            <p class="text-sm text-destructive">{readError}</p>
          {/if}
        </div>
        <div class="flex gap-2">
          <Button type="submit">Save file</Button>
          {#if data.editing}
            <a class={buttonVariants({ variant: "outline" })} href="?">Cancel</a>
          {/if}
        </div>
      </form>
    </CardContent>
  </Card>
</div>
