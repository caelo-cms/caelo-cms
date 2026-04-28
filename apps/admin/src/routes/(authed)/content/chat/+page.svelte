<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { MessageSquare } from "lucide-svelte";
  import EmptyStatePlaceholder from "$lib/components/EmptyStatePlaceholder.svelte";
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Card, CardContent, CardHeader, CardTitle } from "$lib/components/ui/card/index.js";
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
  <div class="flex items-baseline justify-between">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Chats</h1>
      <p class="text-sm text-muted-foreground">Each chat runs on its own ephemeral preview branch.</p>
    </div>
    <form method="post" action="?/create">
      <input type="hidden" name="_csrf" value={data.csrfToken} />
      <Button type="submit">+ New chat</Button>
    </form>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Your chats</CardTitle>
    </CardHeader>
    <CardContent>
      {#if data.sessions.length === 0}
        <EmptyStatePlaceholder
          icon={MessageSquare}
          title="No chats yet"
          description="Chats are how you ask the AI to make changes. Click 'Live edit' on the sidebar or 'New chat' below to start one."
        />
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Last active</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.sessions as s (s.id)}
              <TableRow>
                <TableCell>
                  <a class="font-medium underline-offset-4 hover:underline" href={`/content/chat/${s.id}`}>
                    {s.title}
                  </a>
                </TableCell>
                <TableCell class="text-muted-foreground">{s.lastActiveAt.slice(0, 16)}</TableCell>
                <TableCell>
                  {#if s.publishedAt}
                    <Badge variant="success">published</Badge>
                  {:else}
                    <Badge variant="secondary">open</Badge>
                  {/if}
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {/if}
    </CardContent>
  </Card>
</div>
