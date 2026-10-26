<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { enhance } from "$app/forms";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";

  let { data } = $props();
  const langs = $derived(data.languages);

  /** Operator words for each state the plugin reports. */
  const STATE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
    translated: { label: "Translated", variant: "secondary" },
    needs_update: { label: "Needs update", variant: "outline" },
    missing: { label: "Missing — hidden", variant: "destructive" },
    hidden: { label: "Hidden here", variant: "outline" },
    "link-target-missing": { label: "Page missing — hidden", variant: "destructive" },
    "nothing-to-translate": { label: "Nothing to translate", variant: "secondary" },
  };
</script>

{#if langs.locales.length === 0}
  <p class="text-sm text-muted-foreground">
    The site has only one language. Add one in the chat ("add German") and this tab shows what each
    entry looks like there.
  </p>
{:else}
  <div class="space-y-4">
    <p class="text-sm text-muted-foreground">
      What each entry shows in each language. Missing texts are hidden on that language's pages until
      they are translated — ask the AI in the chat to translate the menus.
    </p>
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b text-left">
            <th class="py-2 pr-4 font-medium">Entry</th>
            {#each langs.locales as l (l.code)}
              <th class="py-2 pr-4 font-medium">{l.displayName}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each langs.entries as e (e.address)}
            <tr class="border-b align-top">
              <td class="py-2 pr-4">{e.label}</td>
              {#each langs.locales as l (l.code)}
                {@const state = e.locales[l.code]}
                <td class="py-2 pr-4">
                  {#if state}
                    <div class="flex flex-wrap items-center gap-2">
                      <Badge variant={STATE[state]?.variant ?? "outline"}>
                        {STATE[state]?.label ?? state}
                      </Badge>
                      {#if data.canWrite}
                        <form method="POST" action="?/visibility" use:enhance>
                          <input type="hidden" name="csrfToken" value={data.csrfToken} />
                          <input type="hidden" name="address" value={e.address} />
                          <input type="hidden" name="localeCode" value={l.code} />
                          <input type="hidden" name="hidden" value={state === "hidden" ? "false" : "true"} />
                          <Button type="submit" variant="ghost" size="sm">
                            {state === "hidden" ? "Show" : "Hide"}
                          </Button>
                        </form>
                      {/if}
                    </div>
                  {/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if langs.findings.length > 0}
      <ul class="space-y-1 text-sm">
        {#each langs.findings as f, i (i)}
          <li>{f.message}</li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}
