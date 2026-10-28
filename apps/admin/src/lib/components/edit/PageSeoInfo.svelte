<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * #1156 — the editor's SEO info for the page in the preview. Title,
   * meta description and the social-share (Open Graph) values live in the
   * page's <head> and never show in the rendered preview, so the info
   * button at the start of the toolbar's page address opens them, with a
   * search-result preview on top. It sits in the toolbar, not over the
   * preview: nothing but the chat covers the page. SEO is draft state like
   * the rest of the page: values this chat changed are marked pending —
   * they reach the live site with the next Stage and a Publish live. The
   * dot on the button says so without opening it; red when the page has no
   * meta description, which a Stage refuses.
   */

  import { Info } from "lucide-svelte";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Popover, PopoverContent, PopoverTrigger } from "#lib/components/ui/popover/index.js";
  import { cn } from "#lib/utils.js";
  import { askInChat } from "./ask-in-chat.js";

  interface PageSeoInfo {
    readonly title: string;
    readonly metaDescription: string;
    readonly ogImageUrl: string | null;
    readonly canonicalUrl: string | null;
    readonly noindex: boolean;
    readonly pending: readonly string[];
    readonly newPage: boolean;
  }

  let {
    info,
    path,
    siteUrl,
  }: {
    info: PageSeoInfo | { readonly error: string };
    /** The shown page's path, for the search-result preview. */
    path: string;
    /** The site's address, or null before it is set (#551). */
    siteUrl: string | null;
  } = $props();
  let open = $state(false);

  const seo = $derived("error" in info ? null : info);
  const pending = $derived(new Set(seo?.pending ?? []));
  const anyPending = $derived(seo !== null && (seo.newPage || pending.size > 0));
  const missingDescription = $derived(seo !== null && seo.metaDescription === "");
  const isPending = (...fields: string[]): boolean =>
    seo !== null && (seo.newPage || fields.some((f) => pending.has(f)));

  /** The result's address line, the way a search engine prints it. */
  const crumb = $derived.by(() => {
    const host = siteUrl ? new URL(siteUrl).host : "your-site";
    const parts = path.split("/").filter((p) => p.length > 0);
    return [host, ...parts].join(" › ");
  });

  const label = $derived(
    "error" in info
      ? "Page SEO could not be loaded"
      : missingDescription
        ? "Page SEO: meta description missing"
        : anyPending
          ? "Page SEO: changes not live yet"
          : "Page SEO",
  );

  const rows = $derived(
    seo === null
      ? []
      : [
          { label: "Title", value: seo.title, fields: ["title"] },
          {
            label: "Meta description",
            value: seo.metaDescription || "None yet — a Stage refuses a published page without one.",
            empty: seo.metaDescription === "",
            fields: ["metaDescription"],
          },
          { label: "Social share title (og:title)", value: seo.title, fields: ["title"] },
          {
            label: "Social share description (og:description)",
            value: seo.metaDescription || "None",
            empty: seo.metaDescription === "",
            fields: ["metaDescription"],
          },
          {
            label: "Canonical URL",
            value: seo.canonicalUrl ?? "The page's own URL",
            empty: seo.canonicalUrl === null,
            fields: ["canonicalUrl"],
          },
          {
            label: "Search engines",
            value: seo.noindex ? "Hidden (noindex)" : "Indexed",
            fields: ["noindex"],
          },
        ],
  );
</script>

<Popover bind:open>
  <PopoverTrigger
    class="relative inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground motion-reduce:transition-none data-[state=open]:bg-accent data-[state=open]:text-foreground"
    aria-label={label}
    title={label}
    data-testid="page-seo-info"
    data-pending={anyPending ? "true" : "false"}
  >
    <Info class="size-4" />
    {#if "error" in info || missingDescription || anyPending}
      <span
        class={cn(
          "absolute right-0.5 top-0.5 size-2 rounded-full border border-background",
          "error" in info || missingDescription ? "bg-red-500" : "bg-amber-500",
        )}
        aria-hidden="true"
      ></span>
    {/if}
  </PopoverTrigger>
  <PopoverContent
    class="max-h-[min(36rem,calc(100vh-6rem))] w-[26rem] overflow-y-auto"
    data-testid="page-seo-popover"
  >
    <div class="space-y-3 p-4">
      <div class="flex items-baseline justify-between gap-3">
        <h2 class="text-sm font-semibold">Page SEO</h2>
        <span class="text-xs text-muted-foreground">Not visible in the preview</span>
      </div>

      {#if seo === null && "error" in info}
        <p class="text-sm text-destructive" role="alert">{info.error}</p>
      {:else if seo}
        <div class="space-y-0.5 rounded-md border bg-muted/40 px-3 py-2" data-testid="page-seo-serp">
          <p class="truncate text-xs text-muted-foreground">{crumb}</p>
          <p class="text-[15px] leading-snug text-link">{seo.title}</p>
          <p
            class={cn(
              "text-xs text-muted-foreground",
              missingDescription && "text-red-700 dark:text-red-300",
            )}
          >
            {seo.metaDescription || "No meta description. Search engines pick a snippet themselves."}
          </p>
        </div>

        {#if anyPending}
          <p
            class="rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
            data-testid="page-seo-pending-note"
          >
            {seo.newPage
              ? "This page is new in this chat's draft: nothing of it is live yet."
              : "Values marked Pending were changed in this chat's draft."}
            They go live with the next Stage and Publish live.
          </p>
        {/if}

        <dl class="divide-y">
          {#each rows as row (row.label)}
            <div class="py-2" data-testid="page-seo-row" data-field={row.fields.join(",")}>
              <dt class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                {row.label}
                {#if isPending(...row.fields)}
                  <Badge variant="warning" data-testid="page-seo-pending">Pending</Badge>
                {/if}
              </dt>
              <dd class={cn("mt-0.5 break-words text-sm", row.empty && "text-muted-foreground italic")}>
                {row.value}
              </dd>
            </div>
          {/each}
          <div class="py-2" data-testid="page-seo-row" data-field="ogImageAssetId">
            <dt class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              Social share image (og:image)
              {#if isPending("ogImageAssetId")}
                <Badge variant="warning" data-testid="page-seo-pending">Pending</Badge>
              {/if}
            </dt>
            <dd class="mt-0.5 text-sm">
              {#if seo.ogImageUrl}
                <img src={seo.ogImageUrl} alt="Social share preview" class="max-h-32 rounded border" />
              {:else}
                <span class="text-muted-foreground italic">None</span>
              {/if}
            </dd>
          </div>
        </dl>
      {/if}
    </div>
    {#if seo}
      <div class="border-t px-4 py-3">
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="page-seo-ask"
          onclick={() => {
            open = false;
            askInChat(`Change the SEO of ${path}: `);
          }}
        >
          Change in chat
        </Button>
      </div>
    {/if}
  </PopoverContent>
</Popover>
