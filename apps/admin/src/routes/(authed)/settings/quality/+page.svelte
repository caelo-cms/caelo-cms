<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Gauge } from "lucide-svelte";
  import EmptyStatePlaceholder from "#lib/components/EmptyStatePlaceholder.svelte";
  import { acceptedValue, groupLiveAcceptances } from "#lib/quality-acceptance-groups.js";
  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { Badge, type BadgeVariant } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
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

  let { data, form } = $props();

  const CATEGORY_LABEL: Record<string, string> = {
    performance: "Performance",
    accessibility: "Accessibility",
    "best-practices": "Best Practices",
    seo: "SEO",
  };

  function statusVariant(status: string): BadgeVariant {
    if (status === "passed" || status === "skipped") return "success";
    if (status === "problems" || status === "errored") return "destructive";
    if (status === "queued" || status === "running") return "secondary";
    return "outline";
  }

  /** Lighthouse's metric rating bands: >= 0.9 good, >= 0.5 average, else poor. */
  function metricClass(score: number | null): string {
    if (score === null) return "text-muted-foreground";
    if (score >= 0.9) return "text-emerald-700 dark:text-emerald-400";
    if (score >= 0.5) return "text-amber-600 dark:text-amber-400";
    return "text-destructive";
  }

  function when(iso: string): string {
    return iso.slice(0, 16).replace("T", " ");
  }

  // #727 — bulk review: live acceptances grouped per decision.
  const acceptanceGroups = $derived(groupLiveAcceptances(data.acceptances));
  const revokedAcceptances = $derived(data.acceptances.filter((a) => a.revokedAt !== null));
  /** Acceptance ids ticked for "Revoke selected". */
  let selectedIds = $state<string[]>([]);
  /** Groups expanded to show their pages. */
  let expanded = $state<Record<string, boolean>>({});

  function toggleIds(ids: readonly string[], on: boolean): void {
    const rest = selectedIds.filter((id) => !ids.includes(id));
    selectedIds = on ? [...rest, ...ids] : rest;
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Quality</h1>
    <p class="text-sm text-muted-foreground">
      Every Stage is checked: page checks (added by plugins) read every page of the staged
      build, and a Stage that changes how pages render is also checked with
      Lighthouse (Performance, Accessibility, Best Practices, SEO). The target is the optimum —
      100 in every category and zero findings. Every finding blocks Publish live until it is
      fixed or an editor accepts it on its pages; warnings and hints only inform.
    </p>
  </div>

  {#each data.loadErrors as e (e)}
    <Alert variant="destructive"><AlertDescription>{e}</AlertDescription></Alert>
  {/each}
  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {:else if form?.message}
    <Alert><AlertDescription>{form.message}</AlertDescription></Alert>
  {/if}

  <Card data-testid="quality-gate-card">
    <CardHeader>
      <CardTitle class="text-base">Publish gate</CardTitle>
      <CardDescription>The quality check of the build staging serves now.</CardDescription>
    </CardHeader>
    <CardContent class="text-sm">
      {#if !data.gate?.gate}
        Nothing is staged yet.
      {:else}
        <div class="flex items-center gap-2">
          <Badge variant={data.gate.gate.open ? "success" : "destructive"}>
            {data.gate.gate.open ? "open" : "blocked"} · {data.gate.gate.state}
          </Badge>
          {#if data.gate.gate.auditRunId}
            <a class="text-xs underline" href={`?run=${data.gate.gate.auditRunId}`}>details</a>
          {/if}
        </div>
        {#if data.gate.gate.message}
          <p class="mt-2 text-muted-foreground">{data.gate.gate.message}</p>
        {/if}
      {/if}
    </CardContent>
  </Card>

  {#if data.detail?.run}
    {@const run = data.detail.run}
    <Card data-testid="quality-audit-detail">
      <CardHeader>
        <CardTitle class="flex items-center gap-2 text-base">
          Audit {run.id.slice(0, 8)}
          <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
          <span class="ml-auto text-xs font-normal text-muted-foreground">{when(run.createdAt)}</span>
        </CardTitle>
        <CardDescription>
          {#if run.classification.auditNeeded}
            Lighthouse ran because: {run.classification.reasons.map((r) => r.label).join("; ")}
          {:else}
            No Lighthouse audit needed: {run.classification.skipped.join("; ") ||
              "no rendering changes"}
          {/if}
          {#if run.checkSummary}
            <br />Page checks ({run.checkSummary.checkIds.join(", ")}) read {run.checkSummary
              .pagesChecked} page(s).
          {/if}
          {#if run.errorMessage}<br />Failed: {run.errorMessage}{/if}
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4 text-sm">
        {#if data.detail.checks && (data.detail.checks.siteProblems.length > 0 || data.detail.checks.siteFindings.length > 0 || data.detail.checks.errors.length > 0)}
          {@const checks = data.detail.checks}
          <div class="rounded-md border p-3" data-testid="quality-site-findings">
            <strong>Site-wide</strong>
            <ul class="mt-2 list-disc pl-5">
              {#each checks.errors as e, i (i)}
                <li class="text-destructive">Check failed: {e.message}</li>
              {/each}
              {#each checks.siteProblems as pr, i (pr.ruleId)}
                <li>
                  {#if data.detail.siteProblemAccepted[i]}<Badge variant="outline">accepted</Badge>{/if}
                  <code>{pr.ruleId}</code> — {pr.findings[0]?.message ?? ""} ({pr.count}×)
                </li>
              {/each}
              {#each checks.siteFindings.filter((f) => f.severity !== "error") as f, i (i)}
                <li class="text-muted-foreground">{f.severity}: <code>{f.ruleId}</code> — {f.message}</li>
              {/each}
            </ul>
          </div>
        {/if}
        {#each data.detail.pages as p (p.pageId)}
          <div class="rounded-md border p-3">
            <div class="flex items-center gap-2">
              <strong>{p.pagePath}</strong>
              <Badge variant={statusVariant(p.status === "clean" ? "passed" : p.status)}>{p.status}</Badge>
            </div>
            {#if p.scores}
              <div class="mt-2 flex flex-wrap gap-3 text-xs">
                {#each Object.entries(p.scores) as [c, s] (c)}
                  <span>
                    {CATEGORY_LABEL[c] ?? c}
                    <strong class={s < 100 ? "text-destructive" : ""}>{s}</strong>
                    <span class="text-muted-foreground">/ 100</span>
                  </span>
                {/each}
              </div>
            {/if}
            {#if p.metrics}
              {@const m = p.metrics}
              <div class="mt-2 space-y-1 text-xs" data-testid="quality-page-metrics">
                <div class="flex flex-wrap gap-3">
                  {#each m.metrics as metric (metric.id)}
                    <span title={metric.unavailableReason ?? metric.title}>
                      {metric.label}
                      <strong class={metricClass(metric.score)}>
                        {metric.displayValue ?? "not measured"}
                      </strong>
                    </span>
                  {/each}
                  <span class="text-muted-foreground">median of {m.runs} run(s)</span>
                </div>
                {#if m.lcpElement}
                  <div class="text-muted-foreground">
                    LCP element: <code>{m.lcpElement.selector ?? m.lcpElement.label}</code>
                    {#if m.lcpBreakdown.length > 0}
                      · {m.lcpBreakdown.map((b) => `${b.label} ${b.durationMs} ms`).join(", ")}
                    {/if}
                  </div>
                {/if}
                {#each m.layoutShifts as shift, i (i)}
                  <div class="text-muted-foreground">
                    Layout shift {shift.score}: <code>{shift.element.selector ?? shift.element.label}</code>
                    {#if shift.causes.length > 0}— {shift.causes.join("; ")}{/if}
                  </div>
                {/each}
              </div>
            {/if}
            {#if p.errorMessage}<p class="mt-2 text-destructive">{p.errorMessage}</p>{/if}
            {#if p.problems.length > 0}
              <ul class="mt-2 list-disc pl-5">
                {#each p.problems as pr, i (i)}
                  <li class={p.problemAccepted[i] ? "text-muted-foreground" : ""}>
                    {#if p.problemAccepted[i]}<Badge variant="outline">accepted</Badge>{/if}
                    {#if pr.kind === "failing_audit"}
                      <code>{pr.auditId}</code> — {pr.title}{pr.displayValue ? ` (${pr.displayValue})` : ""}
                    {:else if pr.kind === "check_rule"}
                      <code>{pr.ruleId}</code> — {pr.findings[0]?.message ?? ""}
                      ({pr.count}×{pr.allowed > 0 ? `, ${pr.allowed} accepted` : ""})
                    {:else}
                      {CATEGORY_LABEL[pr.category] ?? pr.category} {pr.score} is below 100
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
            {#if p.checkFindings.some((f) => f.severity !== "error")}
              <ul class="mt-2 list-disc pl-5 text-muted-foreground" data-testid="quality-check-notes">
                {#each p.checkFindings.filter((f) => f.severity !== "error") as f, i (i)}
                  <li>{f.severity}: <code>{f.ruleId}</code> — {f.message}</li>
                {/each}
              </ul>
            {/if}
          </div>
        {/each}
      </CardContent>
    </Card>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Recent quality checks</CardTitle>
    </CardHeader>
    <CardContent>
      {#if data.runs.length === 0}
        <EmptyStatePlaceholder
          icon={Gauge}
          title="No quality checks yet"
          description="Every Stage is checked automatically: page checks on every page, plus Lighthouse when modules, layouts, templates, the theme, pages or plugin settings changed."
        />
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Problems</TableHead>
              <TableHead>Pages</TableHead>
              <TableHead>Why</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.runs as r (r.id)}
              <TableRow data-testid="quality-run-row">
                <TableCell class="text-muted-foreground">{when(r.createdAt)}</TableCell>
                <TableCell>
                  <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                  {#if r.autoPublish?.outcome}
                    <Badge variant="outline">auto: {r.autoPublish.outcome}</Badge>
                  {/if}
                </TableCell>
                <TableCell>{r.problemCount}</TableCell>
                <TableCell>
                  {r.checkSummary?.pagesChecked ?? 0} checked · {r.pageCount} Lighthouse
                </TableCell>
                <TableCell class="max-w-96 truncate text-xs" title={r.errorMessage ?? ""}>
                  {r.errorMessage ??
                    (r.classification.auditNeeded
                      ? r.classification.reasons.map((x) => x.rule).join(", ")
                      : "page checks only")}
                </TableCell>
                <TableCell><a class="text-xs underline" href={`?run=${r.id}`}>details</a></TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {/if}
    </CardContent>
  </Card>

  <Card data-testid="quality-acceptances-card">
    <CardHeader>
      <CardTitle class="text-base">Accepted findings</CardTitle>
      <CardDescription>
        What editors decided to live with, grouped per decision (one rule across its pages). Each
        acceptance holds the value measured when it was accepted — a worse value blocks again, a
        better one tightens it. {data.canRevoke
          ? "Revoking makes the findings block Publish live on their pages again at once."
          : "Only the Owner can revoke."}
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-3 text-sm">
      {#if acceptanceGroups.length === 0}
        <p class="text-muted-foreground">Nothing accepted.</p>
      {:else}
        <form method="post" action="?/revoke" class="space-y-3" id="quality-revoke-selected">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          {#each selectedIds as id (id)}
            <input type="hidden" name="acceptanceIds" value={id} />
          {/each}
          {#if data.canRevoke}
            <div class="flex flex-wrap items-center gap-2">
              <input
                type="text"
                name="reason"
                placeholder="reason (optional)"
                aria-label="Reason for revoking the selected acceptances (optional)"
                class="w-56 rounded-md border bg-background p-1 text-xs"
              />
              <Button
                type="submit"
                size="sm"
                variant="outline"
                disabled={selectedIds.length === 0}
                data-testid="quality-revoke-selected-btn"
              >
                Revoke selected ({selectedIds.length})
              </Button>
            </div>
          {/if}
        </form>
        {#each acceptanceGroups as g (g.key)}
          {@const ids = g.rows.map((r) => r.id)}
          {@const allSelected = ids.every((id) => selectedIds.includes(id))}
          <div class="rounded-md border p-2" data-testid="quality-acceptance-group" data-group-key={g.key}>
            <div class="flex flex-wrap items-center gap-2">
              {#if data.canRevoke}
                <input
                  type="checkbox"
                  checked={allSelected}
                  aria-label={`Select every page of ${g.label}`}
                  onchange={(e) => toggleIds(ids, e.currentTarget.checked)}
                  data-testid="quality-acceptance-group-select"
                />
              {/if}
              <strong class="min-w-0"><code>{g.label}</code></strong>
              <span class="text-muted-foreground">· {g.rows.length} page(s)</span>
              <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={g.reasons.join(" · ")}>
                {g.reasons.join(" · ")}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-expanded={expanded[g.key] === true}
                onclick={() => (expanded[g.key] = !expanded[g.key])}
              >
                {expanded[g.key] ? "Hide pages" : "Show pages"}
              </Button>
              {#if data.canRevoke}
                <form method="post" action="?/revoke">
                  <input type="hidden" name="_csrf" value={data.csrfToken} />
                  {#each ids as id (id)}
                    <input type="hidden" name="acceptanceIds" value={id} />
                  {/each}
                  <Button type="submit" size="sm" variant="outline" data-testid="quality-revoke-group-btn">
                    Revoke all {g.rows.length}
                  </Button>
                </form>
              {/if}
            </div>
            {#if expanded[g.key]}
              <Table class="mt-2">
                <TableHeader>
                  <TableRow>
                    {#if data.canRevoke}<TableHead class="w-8"></TableHead>{/if}
                    <TableHead>Page</TableHead>
                    <TableHead>Accepted</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {#each g.rows as a (a.id)}
                    <TableRow data-testid="quality-acceptance-row">
                      {#if data.canRevoke}
                        <TableCell>
                          <input
                            type="checkbox"
                            checked={selectedIds.includes(a.id)}
                            aria-label={`Select ${a.pagePath}`}
                            onchange={(e) => toggleIds([a.id], e.currentTarget.checked)}
                            data-testid="quality-acceptance-select"
                          />
                        </TableCell>
                      {/if}
                      <TableCell>{a.pagePath}</TableCell>
                      <TableCell>{acceptedValue(a)}</TableCell>
                      <TableCell class="max-w-96 text-xs">{a.reason}</TableCell>
                      <TableCell class="text-muted-foreground">{when(a.acceptedAt)}</TableCell>
                    </TableRow>
                  {/each}
                </TableBody>
              </Table>
            {/if}
          </div>
        {/each}
      {/if}
      {#if revokedAcceptances.length > 0}
        <details class="text-xs" data-testid="quality-revoked-acceptances">
          <summary class="cursor-pointer text-muted-foreground">
            Revoked or spent ({revokedAcceptances.length})
          </summary>
          <ul class="mt-1 space-y-0.5">
            {#each revokedAcceptances as a (a.id)}
              <li class="text-muted-foreground">
                {a.pagePath}: <code>{a.auditId ?? a.category}</code> ({acceptedValue(a)}) — {a.reason}
                · revoked {when(a.revokedAt ?? a.acceptedAt)}
              </li>
            {/each}
          </ul>
        </details>
      {/if}
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Published without a quality result</CardTitle>
      <CardDescription>
        "Publish anyway" decisions over a failed quality check — who decided and why.
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.overrides.length === 0}
        <p class="text-sm text-muted-foreground">None.</p>
      {:else}
        <ul class="space-y-2 text-sm">
          {#each data.overrides as o (o.id)}
            {#if o.publishOverride}
              <li class="rounded-md border p-2" data-testid="quality-override-row">
                <span class="text-muted-foreground">{when(o.publishOverride.at)}</span> ·
                actor <code>{o.publishOverride.by.slice(0, 8)}</code> ·
                {o.publishOverride.reason}
                <span class="block text-xs text-muted-foreground">Failed check: {o.errorMessage}</span>
              </li>
            {/if}
          {/each}
        </ul>
      {/if}
    </CardContent>
  </Card>
</div>
