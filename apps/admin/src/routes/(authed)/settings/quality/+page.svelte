<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Gauge } from "lucide-svelte";
  import EmptyStatePlaceholder from "#lib/components/EmptyStatePlaceholder.svelte";
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

  function when(iso: string): string {
    return iso.slice(0, 16).replace("T", " ");
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Quality</h1>
    <p class="text-sm text-muted-foreground">
      Every Stage is checked: page checks read every page of the staged build (for example
      meta descriptions), and a Stage that changes how pages render is also checked with
      Lighthouse (Performance, Accessibility, Best Practices, SEO). New errors block Publish live
      until they are fixed or an editor accepts them on their page; warnings and hints only
      inform.
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
              {#each checks.siteProblems as pr (pr.ruleId)}
                <li><code>{pr.ruleId}</code> — {pr.findings[0]?.message ?? ""} ({pr.count}×)</li>
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
                    <strong class={s < (p.baselines[c] ?? 100) ? "text-destructive" : ""}>{s}</strong>
                    <span class="text-muted-foreground">/ {p.baselines[c] ?? 100}</span>
                  </span>
                {/each}
              </div>
            {/if}
            {#if p.errorMessage}<p class="mt-2 text-destructive">{p.errorMessage}</p>{/if}
            {#if p.problems.length > 0}
              <ul class="mt-2 list-disc pl-5">
                {#each p.problems as pr, i (i)}
                  <li>
                    {#if pr.kind === "failing_audit"}
                      <code>{pr.auditId}</code> — {pr.title}{pr.displayValue ? ` (${pr.displayValue})` : ""}
                    {:else if pr.kind === "check_rule"}
                      <code>{pr.ruleId}</code> — {pr.findings[0]?.message ?? ""}
                      ({pr.count}×{pr.allowed > 0 ? `, ${pr.allowed} accepted` : ""})
                    {:else}
                      {CATEGORY_LABEL[pr.category] ?? pr.category} {pr.score} is below its baseline {pr.baseline}
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

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Accepted findings</CardTitle>
      <CardDescription>
        Accepted by editors, per page (or site-wide). An accepted score is the page's baseline for
        that category; an accepted page-check rule covers up to its count of errors, and fewer
        errors lower that count. {data.canRevoke
          ? "Revoking makes the finding block Publish live on its page again."
          : "Only the Owner can revoke."}
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.acceptances.length === 0}
        <p class="text-sm text-muted-foreground">Nothing accepted.</p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Page</TableHead>
              <TableHead>Accepted</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>When</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.acceptances as a (a.id)}
              <TableRow data-testid="quality-acceptance-row">
                <TableCell>{a.pagePath}</TableCell>
                <TableCell>
                  {#if a.kind === "finding"}<code>{a.auditId}</code>{:else if a.kind === "check"}
                    <code>{a.auditId}</code> up to {a.acceptedCount}{:else}
                    {CATEGORY_LABEL[a.category ?? ""] ?? a.category} {a.acceptedScore}{/if}
                </TableCell>
                <TableCell class="max-w-96 text-xs">{a.reason}</TableCell>
                <TableCell class="text-muted-foreground">{when(a.acceptedAt)}</TableCell>
                <TableCell>
                  {#if a.revokedAt}
                    <Badge variant="outline">revoked</Badge>
                  {:else if data.canRevoke}
                    <form method="post" action="?/revoke" class="flex items-center gap-2">
                      <input type="hidden" name="_csrf" value={data.csrfToken} />
                      <input type="hidden" name="acceptanceId" value={a.id} />
                      <input
                        type="text"
                        name="reason"
                        placeholder="reason (optional)"
                        aria-label="Reason for revoking this acceptance (optional)"
                        class="w-40 rounded-md border bg-background p-1 text-xs"
                      />
                      <Button type="submit" size="sm" variant="outline" data-testid="quality-revoke-btn">
                        Revoke
                      </Button>
                    </form>
                  {/if}
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {/if}
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Baselines below 100</CardTitle>
      <CardDescription>
        The ratchet: a page is measured against its last accepted score; improvements raise it
        again automatically.
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.baselines.length === 0}
        <p class="text-sm text-muted-foreground">Every audited page targets 100 in every category.</p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Page</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Baseline</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.baselines as b (`${b.pageId}-${b.category}`)}
              <TableRow>
                <TableCell>{b.pagePath}</TableCell>
                <TableCell>{CATEGORY_LABEL[b.category] ?? b.category}</TableCell>
                <TableCell>{b.baseline}</TableCell>
                <TableCell class="text-muted-foreground">{when(b.updatedAt)}</TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
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
