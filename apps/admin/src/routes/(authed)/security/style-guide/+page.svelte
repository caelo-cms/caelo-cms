<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P10 — per-locale style guide. Free-text markdown describing the
   * tone / voice / formality knobs the AI should apply during Mode 1
   * + Mode 2 translations.
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
  import { Label } from "$lib/components/ui/label/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";

  let { data, form } = $props();
  const csrfToken = $derived(
    typeof window === "undefined" ? "" : (document.cookie.match(/caelo_csrf=([^;]+)/)?.[1] ?? ""),
  );
  let bodyByLocale = $state<Record<string, string>>(
    Object.fromEntries(data.guides.map((g) => [g.locale, g.body])),
  );
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Style guide</h1>
    <p class="text-sm text-muted-foreground">
      Per-locale tone / voice / formality. Each guide is freeform markdown (≤ 4000 chars) injected
      into Mode 1 + Mode 2 translation prompts so the AI matches your editorial voice. Example:
      "Use Sie form (formal). Avoid English loanwords where a German equivalent exists."
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>{form.message ?? "Saved."}</AlertDescription></Alert>
  {/if}

  {#each data.locales as locale (locale.code)}
    <Card>
      <CardHeader>
        <CardTitle class="text-base">
          {locale.code} — {locale.displayName}
        </CardTitle>
        <CardDescription>
          {bodyByLocale[locale.code]
            ? `${(bodyByLocale[locale.code] ?? "").length} chars`
            : "no guide yet"}
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-2">
        <form method="post" action="?/upsert">
          <input type="hidden" name="_csrf" value={csrfToken} />
          <input type="hidden" name="locale" value={locale.code} />
          <Label for={`sg-${locale.code}`}>Body</Label>
          <Textarea
            id={`sg-${locale.code}`}
            name="body"
            rows={6}
            maxlength={4000}
            value={bodyByLocale[locale.code] ?? ""}
            placeholder="e.g. Use Sie form. Avoid English loanwords. Numbers stay in source format."
            class="font-mono text-sm"
          />
          <div class="mt-2 flex gap-2">
            <Button type="submit" size="sm">Save</Button>
            {#if bodyByLocale[locale.code]}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onclick={(ev) => {
                  ev.preventDefault();
                  const f = (ev.target as HTMLElement).closest("div")?.parentElement?.querySelector('form[action="?/delete"]') as HTMLFormElement | null;
                  f?.requestSubmit();
                }}
              >
                <Trash2 class="size-4" />
              </Button>
            {/if}
          </div>
        </form>
        <form method="post" action="?/delete" class="hidden">
          <input type="hidden" name="_csrf" value={csrfToken} />
          <input type="hidden" name="locale" value={locale.code} />
        </form>
      </CardContent>
    </Card>
  {/each}
</div>
