<!-- SPDX-License-Identifier: MPL-2.0 -->
<script lang="ts">
  // #1764, #1776 — the CPU this site's jobs may use (the quality check's
  // Lighthouse runs, a search index's tasks, plugin jobs, screenshots), read
  // live, what runs and waits for it now, and how an Owner makes it faster.
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#lib/components/ui/card/index.js";
  import type { CloudCapacityView } from "#lib/server/cloud-capacity-view.js";

  let { capacity }: { capacity: Promise<CloudCapacityView> } = $props();

  const n = (v: number) => v.toLocaleString("en-US");
  const since = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
</script>

{#await capacity}
  <Card data-testid="cloud-capacity">
    <CardHeader>
      <CardTitle class="text-base">Job capacity</CardTitle>
      <CardDescription>Reading the CPU the jobs may use…</CardDescription>
    </CardHeader>
  </Card>
{:then view}
  {#if view.state === "error"}
    <Card data-testid="cloud-capacity">
      <CardHeader>
        <CardTitle class="text-base">Job capacity</CardTitle>
        <CardDescription class="text-destructive" data-testid="cloud-capacity-error">
          {view.message}
        </CardDescription>
      </CardHeader>
    </Card>
  {:else if view.state === "ok"}
    {@const r = view.reading}
    <Card data-testid="cloud-capacity">
      <CardHeader>
        <CardTitle class="text-base">Job capacity</CardTitle>
        <CardDescription>
          {#if r.source === "quota"}
            Caelo shares one CPU budget among its jobs: quality checks first, then the search
            index, then plugin jobs. Google Cloud sets it with project <code>{r.projectId}</code>'s
            Cloud Run CPU quota in <code>{r.region}</code>, read just now.
          {:else}
            Caelo runs its jobs inside the admin on this machine, one job of each kind at a
            time.
          {/if}
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4 text-sm">
        <dl class="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
          <dt class="text-muted-foreground">{r.source === "quota" ? "CPU quota" : "This machine"}</dt>
          <dd data-testid="cloud-capacity-quota">
            {#if r.budgetVcpu === null}
              {r.source === "quota" ? "no limit" : "no CPU budget: one job of each kind at a time"}
            {:else if r.source === "quota"}
              {n(r.quotaVcpu ?? 0)} vCPU: {r.reserveVcpu} stay free for the admin and the site, {n(
                r.budgetVcpu,
              )} for the jobs
            {/if}
          </dd>
          <dt class="text-muted-foreground">Quality check</dt>
          <dd data-testid="cloud-capacity-check">
            {view.lighthouseRuns} of up to {view.maxLighthouseTasks} Lighthouse runs at once{#if view.checkRounds > 1}:
              a full check takes about {view.checkRounds} rounds instead of one{/if}
          </dd>
          <dt class="text-muted-foreground">Search index</dt>
          <dd data-testid="cloud-capacity-index">
            up to {view.indexTasks} of {view.maxIndexTasks} tasks for a large build (a first index with
            semantic search, a model change) while no quality check runs, and one beside it;
            everyday updates need one
          </dd>
          <dt class="text-muted-foreground">Plugin jobs</dt>
          <dd>run when the checks and the search index leave room; a job in pieces gives its CPU back after each piece</dd>
        </dl>

        {#if view.jobs === null}
          <p class="text-muted-foreground" data-testid="cloud-capacity-jobs-error">
            What runs right now could not be read; the server log says why.
          </p>
        {:else if view.jobs.length === 0}
          <p class="text-muted-foreground" data-testid="cloud-capacity-jobs-none">No job runs right now.</p>
        {:else}
          <div data-testid="cloud-capacity-jobs">
            <p class="font-medium">Right now</p>
            <ul class="mt-2 space-y-2">
              {#each view.jobs as job (job.key)}
                <li class="flex flex-wrap items-baseline gap-x-2" data-testid="cloud-capacity-job">
                  <Badge variant={job.state === "running" ? "default" : "outline"}>
                    {job.state === "running" ? "running" : "waiting"}
                  </Badge>
                  <span>{job.label}</span>
                  <span class="text-muted-foreground"
                    >{job.vcpu} vCPU{#if job.width}, {job.width}{/if}, since {since(job.since)}</span
                  >
                  {#if job.reason}
                    <span class="basis-full text-muted-foreground" data-testid="cloud-capacity-job-reason"
                      >{job.reason}</span
                    >
                  {/if}
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        {#if view.limited && view.consoleUrl}
          <div class="rounded-md border p-3" data-testid="cloud-capacity-speed-up">
            <p class="font-medium">How to make them faster</p>
            <ol class="mt-2 list-decimal space-y-1 pl-5">
              <li>
                Open the
                <a class="underline" href={view.consoleUrl} target="_blank" rel="noopener noreferrer"
                  >Quotas page of project {r.projectId}</a
                > in the Google Cloud console (IAM &amp; Admin → Quotas).
              </li>
              <li>
                Filter for <code>{view.metric}</code> and tick the row for <code>{r.region}</code>.
              </li>
              <li>
                Click <em>Edit quotas</em>, enter <strong>{n(view.fullSpeedVcpu)} vCPU</strong> ({n(
                  view.checkFullSpeedVcpu,
                )} is enough for every quality check at full speed), and send the request with a
                short reason, for example "Parallel quality checks and search index builds of our
                website (Caelo CMS)".
              </li>
              <li>
                Google usually answers within minutes, sometimes within two days. Caelo uses the
                new quota from the next job start on: nothing else to do.
              </li>
            </ol>
          </div>
        {:else if r.source === "quota"}
          <p class="text-muted-foreground" data-testid="cloud-capacity-full">
            Every job runs at full width.
          </p>
        {/if}
      </CardContent>
    </Card>
  {/if}
{/await}
