<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Epic #1644 (#1645) — one plugin's settings, generated from what the
   * plugin declares. Saved values reach visitors with the next Stage and
   * Publish live, like every other change.
   */

  import ConfigForm from "#lib/components/plugin-config/ConfigForm.svelte";
  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#lib/components/ui/card/index.js";

  let { data, form } = $props();

  const KIND_LABEL: Record<string, string> = {
    page: "Per page",
    module: "Per module",
    contentInstance: "Per content block",
    pageType: "Per page type",
  };
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Settings of {data.slug}</h1>
    <p class="text-sm text-muted-foreground">
      What you change here is saved at once and reaches your site with the next Stage and Publish live. In a chat,
      just tell the AI what you want; it reads and changes these settings for you.
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>{form.message}</AlertDescription></Alert>
  {/if}

  {#if data.fields.length > 0}
    <ConfigForm fields={data.fields as never} values={data.values} pageTypes={data.pageTypes} lists={data.lists} csrfToken={data.csrfToken} />
  {/if}

  {#each Object.entries(data.entityFields) as [kind, fields] (kind)}
    <Card>
      <CardHeader>
        <CardTitle>{KIND_LABEL[kind] ?? kind}</CardTitle>
        <CardDescription>
          Set on the {kind === "page" ? "page's settings" : kind === "module" ? "module's page" : "entity's page"}, or ask the AI. Unset fields
          use the default shown here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul class="space-y-2 text-sm">
          {#each fields as f ((f as { path: string }).path)}
            {@const field = f as { path: string; label: string; description: string; allowed: string }}
            <li><span class="font-medium">{field.label}</span>: {field.description} <span class="text-muted-foreground">({field.allowed})</span></li>
          {/each}
        </ul>
      </CardContent>
    </Card>
  {/each}
</div>
