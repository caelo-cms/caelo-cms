<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { buttonVariants } from "$lib/components/ui/button/button-variants.js";
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
  <div class="flex items-start justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Layouts</h1>
      <p class="text-sm text-muted-foreground">
        Site-wide chrome (header / footer / nav). Every template binds to one layout; pages inherit
        the layout via their template. The `content` slot always holds the rendered template body.
      </p>
    </div>
    <a href="/security/layouts/new" class={buttonVariants({ variant: "default" })}>New layout</a>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Existing layouts</CardTitle>
    </CardHeader>
    <CardContent>
      {#if data.layouts.length === 0}
        <p class="text-sm text-muted-foreground">No layouts yet — click "New layout" to create one.</p>
      {:else}
        <ul class="space-y-3">
          {#each data.layouts as layout (layout.id)}
            <li class="rounded-md border p-3 text-sm">
              <div class="flex flex-wrap items-center gap-2">
                <strong>{layout.slug}</strong>
                <span class="text-muted-foreground">— {layout.displayName}</span>
                <Badge variant="outline">
                  {layout.templates.length} template{layout.templates.length === 1 ? "" : "s"}
                </Badge>
                <div class="ml-auto flex items-center gap-2">
                  <a
                    href={`/security/layouts/${layout.id}`}
                    class={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    Edit
                  </a>
                  <form method="post" action="?/delete">
                    <input type="hidden" name="_csrf" value={data.csrfToken} />
                    <input type="hidden" name="layoutId" value={layout.id} />
                    <Button
                      type="submit"
                      size="sm"
                      variant="destructive"
                      disabled={layout.templates.length > 0}
                      title={layout.templates.length > 0
                        ? "Re-point referencing templates first"
                        : "Delete layout"}
                    >
                      Delete
                    </Button>
                  </form>
                </div>
              </div>
              <p class="mt-1 text-xs text-muted-foreground">
                Blocks: {layout.blocks
                  .slice()
                  .sort((a, b) => a.position - b.position)
                  .map((b) => b.name)
                  .join(", ") || "(none)"}
              </p>
              {#if layout.templates.length > 0}
                <p class="mt-1 text-xs text-muted-foreground">
                  Templates bound: {layout.templates.join(", ")}
                </p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </CardContent>
  </Card>
</div>
