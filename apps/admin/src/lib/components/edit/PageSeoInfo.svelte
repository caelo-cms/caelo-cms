<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * #1156 — the editor's SEO info for the page in the preview. Title,
   * meta description and the social-share (Open Graph) values live in the
   * page's <head> and never show in the rendered preview, so an info button
   * in the preview's top corner opens them. SEO is draft state like the
   * rest of the page: values this chat changed are marked pending — they
   * reach the live site with the next Stage and a Publish live.
   */

  import { Info } from "lucide-svelte";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
  } from "#lib/components/ui/sheet/index.js";
  import { cn } from "#lib/utils.js";

  interface PageSeoInfo {
    readonly title: string;
    readonly metaDescription: string;
    readonly ogImageUrl: string | null;
    readonly canonicalUrl: string | null;
    readonly noindex: boolean;
    readonly pending: readonly string[];
    readonly newPage: boolean;
  }

  let { info }: { info: PageSeoInfo | { readonly error: string } } = $props();
  let open = $state(false);

  const seo = $derived("error" in info ? null : info);
  const pending = $derived(new Set(seo?.pending ?? []));
  const anyPending = $derived(seo !== null && (seo.newPage || pending.size > 0));
  const isPending = (...fields: string[]): boolean =>
    seo !== null && (seo.newPage || fields.some((f) => pending.has(f)));

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

<button
  type="button"
  onclick={() => (open = true)}
  class="absolute left-3 top-3 z-20 inline-flex size-8 items-center justify-center rounded-full border bg-background/95 text-foreground shadow-sm backdrop-blur transition-colors hover:bg-accent motion-reduce:transition-none"
  aria-label={anyPending ? "Page SEO — has pending changes" : "Page SEO"}
  title={anyPending ? "Page SEO — changes not live yet" : "Page SEO"}
  data-testid="page-seo-info"
  data-pending={anyPending ? "true" : "false"}
>
  <Info class="size-4" />
  {#if anyPending}
    <span
      class="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-background bg-amber-500"
      aria-hidden="true"
    ></span>
  {/if}
</button>

<Sheet bind:open>
  <SheetContent side="left" class="overflow-y-auto" data-testid="page-seo-sheet">
    <SheetHeader>
      <SheetTitle>Page SEO</SheetTitle>
      <SheetDescription>
        What search results and social shares show for this page. These values are not visible
        in the preview.
      </SheetDescription>
    </SheetHeader>

    {#if seo === null && "error" in info}
      <p class="mt-4 text-sm text-destructive" role="alert">{info.error}</p>
    {:else if seo}
      {#if anyPending}
        <p
          class="mt-4 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
          data-testid="page-seo-pending-note"
        >
          {seo.newPage
            ? "This page is new in this chat's draft: nothing of it is live yet."
            : "Values marked Pending were changed in this chat's draft."}
          They go live with the next Stage and Publish live.
        </p>
      {/if}

      <dl class="mt-4 space-y-4">
        {#each rows as row (row.label)}
          <div data-testid="page-seo-row" data-field={row.fields.join(",")}>
            <dt class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              {row.label}
              {#if isPending(...row.fields)}
                <Badge variant="warning" data-testid="page-seo-pending">Pending</Badge>
              {/if}
            </dt>
            <dd class={cn("mt-1 break-words text-sm", row.empty && "text-muted-foreground italic")}>
              {row.value}
            </dd>
          </div>
        {/each}
        <div data-testid="page-seo-row" data-field="ogImageAssetId">
          <dt class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            Social share image (og:image)
            {#if isPending("ogImageAssetId")}
              <Badge variant="warning" data-testid="page-seo-pending">Pending</Badge>
            {/if}
          </dt>
          <dd class="mt-1 text-sm">
            {#if seo.ogImageUrl}
              <img src={seo.ogImageUrl} alt="Social share preview" class="max-h-40 rounded border" />
            {:else}
              <span class="text-muted-foreground italic">None</span>
            {/if}
          </dd>
        </div>
      </dl>
      <p class="mt-6 text-xs text-muted-foreground">
        Ask the chat to change any of these, e.g. "rewrite the meta description of this page".
      </p>
    {/if}
  </SheetContent>
</Sheet>
