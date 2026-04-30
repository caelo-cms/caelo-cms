<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P10 — Owner glossary editor. Per-locale canonical translations of
   * source terms. Read by every Mode 1 / Mode 2 prompt as injected
   * context so the AI keeps terminology consistent across pages.
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
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/components/ui/table/index.js";

  let { data, form } = $props();
  const csrfToken = $derived(
    typeof window === "undefined" ? "" : (document.cookie.match(/caelo_csrf=([^;]+)/)?.[1] ?? ""),
  );
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Glossary</h1>
    <p class="text-sm text-muted-foreground">
      Canonical translations the AI must follow. Useful for proper nouns ("Caelo" → "Caelo"),
      brand-specific renderings, or industry terms with a preferred translation. Each entry is
      injected into Mode 1 + Mode 2 prompts for the matching locale.
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
      <CardTitle class="text-base">New / update entry</CardTitle>
      <CardDescription>
        Adding an entry with the same (sourceTerm, locale) as an existing one updates the
        translation in place.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/upsert" class="grid grid-cols-1 gap-3 md:grid-cols-2">
        <input type="hidden" name="_csrf" value={csrfToken} />
        <div>
          <Label for="g-source">Source term</Label>
          <Input id="g-source" name="sourceTerm" required maxlength={200} />
        </div>
        <div>
          <Label for="g-locale">Locale</Label>
          <select
            id="g-locale"
            name="locale"
            required
            class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
          >
            <option value="" disabled selected>Select locale…</option>
            {#each data.locales as l (l.code)}
              <option value={l.code}>{l.code} — {l.displayName}</option>
            {/each}
          </select>
        </div>
        <div>
          <Label for="g-trans">Translation</Label>
          <Input id="g-trans" name="translation" required maxlength={500} />
        </div>
        <div>
          <Label for="g-ctx">Context (optional)</Label>
          <Input id="g-ctx" name="context" maxlength={500} placeholder="e.g. brand name — never translate" />
        </div>
        <div class="md:col-span-2">
          <Button type="submit">Save entry</Button>
        </div>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Existing entries ({data.entries.length})</CardTitle>
    </CardHeader>
    <CardContent>
      {#if data.entries.length === 0}
        <p class="text-sm text-muted-foreground">No glossary entries yet.</p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Source term</TableHead>
              <TableHead>Locale</TableHead>
              <TableHead>Translation</TableHead>
              <TableHead>Context</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.entries as e (e.id)}
              <TableRow>
                <TableCell class="font-mono">{e.sourceTerm}</TableCell>
                <TableCell class="font-mono">{e.locale}</TableCell>
                <TableCell>{e.translation}</TableCell>
                <TableCell class="text-xs text-muted-foreground">{e.context ?? ""}</TableCell>
                <TableCell>
                  <form method="post" action="?/delete">
                    <input type="hidden" name="_csrf" value={csrfToken} />
                    <input type="hidden" name="id" value={e.id} />
                    <Button type="submit" size="sm" variant="ghost">
                      <Trash2 class="size-4" />
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
</div>
