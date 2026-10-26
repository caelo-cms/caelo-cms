<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * A plugin panel's table: filters (plain links, so a view is a URL),
   * rows rendered as text, per-row / bulk / toolbar actions, paging and
   * the CSV download. Row data arrives already projected to the declared
   * columns and action arguments (`#lib/server/plugin-panels.ts`).
   */

  import { page } from "$app/state";
  import EmptyStatePlaceholder from "#lib/components/EmptyStatePlaceholder.svelte";
  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { buttonVariants } from "#lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "#lib/components/ui/table/index.js";
  import type { TableState } from "#lib/plugin-panels.js";
  import { cn } from "#lib/utils.js";
  import ActionForm from "./ActionForm.svelte";
  import PanelValue from "./PanelValue.svelte";

  interface Props {
    view: TableState;
    csrfToken: string;
  }
  let { view, csrfToken }: Props = $props();

  const section = $derived(view.section);
  const selectable = $derived((section.bulkActions?.length ?? 0) > 0);
  const hasRowActions = $derived((section.rowActions?.length ?? 0) > 0);
  const actionsById = $derived(new Map((section.rowActions ?? []).map((a) => [a.id, a])));

  let selected = $state<string[]>([]);
  // A reload (after an action) can drop rows; keep only keys still shown.
  $effect(() => {
    const shown = new Set(view.rows.map((r) => JSON.stringify(r.key)));
    const kept = selected.filter((k) => shown.has(k));
    if (kept.length !== selected.length) selected = kept;
  });

  function toggle(key: string): void {
    selected = selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key];
  }

  function filterHref(param: string, value: string | null): string {
    const next = new URL(page.url.href);
    if (value === null) next.searchParams.delete(param);
    else next.searchParams.set(param, value);
    // A new filter starts from the first page.
    next.searchParams.delete(`${section.id}.cursor`);
    return `${next.pathname}${next.search}`;
  }

  function reviewHref(actionId: string, args: Record<string, unknown>): string {
    const next = new URL(page.url.href);
    next.searchParams.set("review", `${section.id}.${actionId}`);
    next.searchParams.set("reviewArgs", JSON.stringify(args));
    return `${next.pathname}${next.search}`;
  }

  const selectedIds = $derived(JSON.stringify(selected.map((k) => JSON.parse(k))));
</script>

<Card data-testid="panel-section-{section.id}">
  <CardHeader>
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="space-y-1.5">
        <CardTitle>{section.title}</CardTitle>
        {#if section.description}
          <CardDescription>{section.description}</CardDescription>
        {/if}
      </div>
      <div class="flex flex-wrap items-center gap-2">
        {#each section.actions ?? [] as action (action.id)}
          <ActionForm
            action="?/toolbar"
            {csrfToken}
            fields={{ section: section.id, action: action.id }}
            label={action.label}
            variant={action.variant}
            confirm={action.confirm}
          />
        {/each}
        {#if view.downloadHref && section.download}
          <a
            href={view.downloadHref}
            download={section.download.filename}
            class={buttonVariants({ variant: "outline", size: "sm" })}
          >
            {section.download.label}
          </a>
        {/if}
      </div>
    </div>
  </CardHeader>
  <CardContent class="space-y-4">
    {#if view.filters.length > 0}
      <div class="flex flex-wrap gap-4">
        {#each view.filters as filter (filter.arg)}
          <nav aria-label={filter.label} class="flex flex-wrap items-center gap-1 text-sm">
            <span class="mr-1 text-muted-foreground">{filter.label}:</span>
            {#if filter.allLabel}
              <a
                href={filterHref(filter.param, null)}
                aria-current={filter.selected === null ? "page" : undefined}
                class={cn(
                  buttonVariants({ variant: filter.selected === null ? "secondary" : "ghost", size: "sm" }),
                )}>{filter.allLabel}</a
              >
            {/if}
            {#each filter.options as option (option.value)}
              <a
                href={filterHref(filter.param, option.value)}
                aria-current={filter.selected === option.value ? "page" : undefined}
                class={cn(
                  buttonVariants({
                    variant: filter.selected === option.value ? "secondary" : "ghost",
                    size: "sm",
                  }),
                )}>{option.label}</a
              >
            {/each}
          </nav>
        {/each}
      </div>
    {/if}

    {#if view.error}
      <Alert variant="destructive">
        <AlertDescription>The plugin could not load this list: {view.error}</AlertDescription>
      </Alert>
    {:else if view.rows.length === 0}
      <EmptyStatePlaceholder description={section.emptyMessage} />
    {:else}
      {#if selectable && selected.length > 0}
        <div
          class="flex flex-wrap items-center gap-2 rounded-md border bg-accent/50 p-3"
          data-testid="panel-bulk-{section.id}"
        >
          <span class="text-sm font-medium">{selected.length} selected</span>
          {#each section.bulkActions ?? [] as action (action.id)}
            <ActionForm
              action="?/bulk"
              {csrfToken}
              fields={{ section: section.id, action: action.id, ids: selectedIds }}
              label={action.label}
              variant={action.variant}
              confirm={action.confirm}
            />
          {/each}
        </div>
      {/if}
      <Table>
        <TableHeader>
          <TableRow>
            {#if selectable}<TableHead class="w-8"><span class="sr-only">Select</span></TableHead>{/if}
            {#each section.columns as column (column.key)}
              <TableHead class={cn(column.format === "number" && "text-right")}>{column.label}</TableHead>
            {/each}
            {#if hasRowActions}<TableHead class="text-right">Actions</TableHead>{/if}
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each view.rows as row, i (row.key === null ? `#${i}` : JSON.stringify(row.key))}
            {@const key = JSON.stringify(row.key)}
            <TableRow data-testid="panel-row">
              {#if selectable}
                <TableCell>
                  {#if row.key !== null}
                    <input
                      type="checkbox"
                      class="size-4"
                      aria-label="Select row {i + 1}"
                      checked={selected.includes(key)}
                      onchange={() => toggle(key)}
                    />
                  {/if}
                </TableCell>
              {/if}
              {#each section.columns as column, c (column.key)}
                <TableCell class={cn("align-top", column.format === "number" && "text-right")}>
                  <PanelValue display={column} value={row.cells[c]} />
                </TableCell>
              {/each}
              {#if hasRowActions}
                <TableCell class="align-top">
                  <div class="flex flex-wrap justify-end gap-2">
                    {#each row.actions as rowAction (rowAction.id)}
                      {@const declared = actionsById.get(rowAction.id)}
                      {#if declared?.review}
                        <a
                          href={reviewHref(rowAction.id, rowAction.args)}
                          class={buttonVariants({ variant: declared.variant, size: "sm" })}
                          >{declared.label}</a
                        >
                      {:else if declared}
                        <ActionForm
                          action="?/row"
                          {csrfToken}
                          fields={{
                            section: section.id,
                            action: rowAction.id,
                            args: JSON.stringify(rowAction.args),
                          }}
                          label={declared.label}
                          variant={declared.variant}
                          confirm={declared.confirm}
                        />
                      {/if}
                    {/each}
                  </div>
                </TableCell>
              {/if}
            </TableRow>
          {/each}
        </TableBody>
      </Table>
      {#if view.nextPageHref || view.firstPageHref}
        <div class="flex justify-end gap-2">
          {#if view.firstPageHref}
            <a href={view.firstPageHref} class={buttonVariants({ variant: "outline", size: "sm" })}
              >First page</a
            >
          {/if}
          {#if view.nextPageHref}
            <a href={view.nextPageHref} class={buttonVariants({ variant: "outline", size: "sm" })}
              >Next page</a
            >
          {/if}
        </div>
      {/if}
    {/if}
  </CardContent>
</Card>
