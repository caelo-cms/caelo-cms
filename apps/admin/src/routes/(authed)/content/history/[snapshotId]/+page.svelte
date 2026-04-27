<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";

  let { data, form } = $props();
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">
      Snapshot {data.snapshot.id.slice(0, 8)}
    </h1>
    <p class="text-sm text-muted-foreground">
      <strong>{data.snapshot.description}</strong> — {data.snapshot.createdAt}
    </p>
    {#if data.snapshot.revertOf}
      <Badge variant="outline" class="mt-2">
        Revert of snapshot {data.snapshot.revertOf.slice(0, 8)}
      </Badge>
    {/if}
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>{form.ok}</AlertDescription></Alert>
  {/if}

  {#if data.modules.length > 0}
    <Card>
      <CardHeader>
        <CardTitle class="text-base">Modules ({data.modules.length})</CardTitle>
      </CardHeader>
      <CardContent>
        <ul class="space-y-2">
          {#each data.modules as m (m.entityId)}
            <li class="flex items-center justify-between gap-2 text-sm">
              <span><strong>{m.state.slug}</strong> — {m.state.displayName}</span>
              <form method="post" action="?/revertModule">
                <input type="hidden" name="_csrf" value={data.csrfToken} />
                <input type="hidden" name="moduleId" value={m.entityId} />
                <Button type="submit" variant="outline" size="sm">Revert this module</Button>
              </form>
            </li>
          {/each}
        </ul>
      </CardContent>
    </Card>
  {/if}

  {#if data.templates.length > 0}
    <Card>
      <CardHeader>
        <CardTitle class="text-base">Templates ({data.templates.length})</CardTitle>
      </CardHeader>
      <CardContent>
        <ul class="space-y-2">
          {#each data.templates as t (t.entityId)}
            <li class="flex items-center justify-between gap-2 text-sm">
              <span><strong>{t.state.slug}</strong> — {t.state.displayName}</span>
              <form method="post" action="?/revertTemplate">
                <input type="hidden" name="_csrf" value={data.csrfToken} />
                <input type="hidden" name="templateId" value={t.entityId} />
                <Button type="submit" variant="outline" size="sm">Revert this template</Button>
              </form>
            </li>
          {/each}
        </ul>
      </CardContent>
    </Card>
  {/if}

  {#if data.pages.length > 0}
    <Card>
      <CardHeader>
        <CardTitle class="text-base">Pages ({data.pages.length})</CardTitle>
      </CardHeader>
      <CardContent>
        <ul class="space-y-2">
          {#each data.pages as p (p.entityId)}
            <li class="flex items-center justify-between gap-2 text-sm">
              <span><strong>{p.state.slug}</strong> ({p.state.locale}) — {p.state.title}</span>
              <form method="post" action="?/revertPage">
                <input type="hidden" name="_csrf" value={data.csrfToken} />
                <input type="hidden" name="pageId" value={p.entityId} />
                <Button type="submit" variant="outline" size="sm">Revert this page (metadata)</Button>
              </form>
            </li>
          {/each}
        </ul>
      </CardContent>
    </Card>
  {/if}

  {#if data.pageLayouts.length > 0}
    <Card>
      <CardHeader>
        <CardTitle class="text-base">Page layouts ({data.pageLayouts.length})</CardTitle>
      </CardHeader>
      <CardContent>
        <ul class="space-y-2">
          {#each data.pageLayouts as l (l.entityId)}
            <li class="flex items-center justify-between gap-2 text-sm">
              <span>Layout for page {l.entityId.slice(0, 8)}</span>
              <form method="post" action="?/revertPage">
                <input type="hidden" name="_csrf" value={data.csrfToken} />
                <input type="hidden" name="pageId" value={l.entityId} />
                <Button type="submit" variant="outline" size="sm">Restore this layout</Button>
              </form>
            </li>
          {/each}
        </ul>
      </CardContent>
    </Card>
  {/if}

  <Card class="border-destructive/50">
    <CardHeader>
      <CardTitle class="text-base text-destructive">Or revert everything in this snapshot</CardTitle>
    </CardHeader>
    <CardContent>
      <form
        method="post"
        action="?/revertSite"
        onsubmit={(e) => {
          if (!confirm("Revert the entire site to this snapshot? A new snapshot will be appended.")) {
            e.preventDefault();
          }
        }}
      >
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <Button type="submit" variant="destructive">Revert site to this snapshot</Button>
      </form>
    </CardContent>
  </Card>
</div>
