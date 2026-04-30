<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P10A — Owner skills control panel. Two columns: active/inactive
   * skills + AI-proposed skills awaiting Owner review.
   */

  import { Sparkles } from "lucide-svelte";
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
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
    <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <Sparkles class="size-6" />
      Skills
    </h1>
    <p class="text-sm text-muted-foreground">
      Skill bodies augment the AI's system prompt when engaged. Auto-engagement runs every turn
      against site-active skills; users can manually engage / disengage in any chat. New AI-drafted
      skills land in the proposals queue below — accept brings them in at
      <code>awaiting_activation</code>, then activate them separately.
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
      <CardTitle class="text-base">Site skills ({data.skills.length})</CardTitle>
      <CardDescription>
        Each row is a skill. Status flow: <code>awaiting_activation</code> →
        <code>active</code> (matcher candidate) → <code>archived</code> (no longer engaged).
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.skills.length === 0}
        <p class="text-sm text-muted-foreground">No skills yet.</p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Slug</TableHead>
              <TableHead>Display name</TableHead>
              <TableHead>Hints</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.skills as s (s.id)}
              <TableRow>
                <TableCell class="font-mono text-xs">{s.slug}</TableCell>
                <TableCell>{s.displayName}</TableCell>
                <TableCell class="text-xs">
                  {s.hints.alwaysOn ? "always-on " : ""}
                  {s.hints.chipTrigger ? "chip-trigger " : ""}
                  {s.hints.keywords.length > 0 ? `kw: ${s.hints.keywords.slice(0, 3).join(", ")}` : ""}
                </TableCell>
                <TableCell class="text-xs font-mono">{s.status}</TableCell>
                <TableCell>
                  <div class="flex gap-1">
                    {#if s.status !== "active"}
                      <form method="post" action="?/setStatus">
                        <input type="hidden" name="_csrf" value={csrfToken} />
                        <input type="hidden" name="slug" value={s.slug} />
                        <input type="hidden" name="status" value="active" />
                        <Button type="submit" size="sm" variant="outline">Activate</Button>
                      </form>
                    {/if}
                    {#if s.status !== "archived"}
                      <form method="post" action="?/setStatus">
                        <input type="hidden" name="_csrf" value={csrfToken} />
                        <input type="hidden" name="slug" value={s.slug} />
                        <input type="hidden" name="status" value="archived" />
                        <Button type="submit" size="sm" variant="ghost">Archive</Button>
                      </form>
                    {/if}
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
      <CardTitle class="text-base">
        AI proposals ({data.proposals.length})
      </CardTitle>
      <CardDescription>
        AI-drafted skills awaiting your review. Accept lands the row at
        <code>awaiting_activation</code> — you activate separately.
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-3">
      {#if data.proposals.length === 0}
        <p class="text-sm text-muted-foreground">No pending proposals.</p>
      {/if}
      {#each data.proposals as p (p.id)}
        <div class="rounded border p-3">
          <div class="flex items-center justify-between">
            <div>
              <div class="font-mono text-xs">{p.slug}</div>
              <div class="text-sm">{p.displayName}</div>
              <div class="text-xs text-muted-foreground">
                proposed {new Date(p.createdAt).toLocaleString()}
              </div>
            </div>
          </div>
          <p class="mt-2 text-sm">{p.description}</p>
          <details class="mt-2">
            <summary class="cursor-pointer text-xs text-muted-foreground">
              Body + rationale
            </summary>
            <p class="mt-1 text-xs italic">{p.rationale}</p>
            <pre class="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 text-xs">{p.body}</pre>
          </details>
          <div class="mt-3 flex items-center gap-2">
            <form method="post" action="?/reviewProposal">
              <input type="hidden" name="_csrf" value={csrfToken} />
              <input type="hidden" name="proposalId" value={p.id} />
              <input type="hidden" name="decision" value="accept" />
              <Button type="submit" size="sm">Accept</Button>
            </form>
            <form method="post" action="?/reviewProposal" class="flex items-center gap-2">
              <input type="hidden" name="_csrf" value={csrfToken} />
              <input type="hidden" name="proposalId" value={p.id} />
              <input type="hidden" name="decision" value="reject" />
              <input
                type="text"
                name="note"
                placeholder="Reason (optional)"
                class="rounded border px-2 py-1 text-sm"
                maxlength="1000"
              />
              <Button type="submit" size="sm" variant="outline">Reject</Button>
            </form>
          </div>
        </div>
      {/each}
    </CardContent>
  </Card>
</div>
