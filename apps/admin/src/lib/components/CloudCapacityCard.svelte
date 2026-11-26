<!-- SPDX-License-Identifier: MPL-2.0 -->
<script lang="ts">
  // #1764 — how many job tasks the project's Cloud Run CPU quota lets this
  // site run at once (the quality check's Lighthouse runs, a large search
  // index's tasks), read live, and how an Owner makes them faster.
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#lib/components/ui/card/index.js";
  import type { CloudCapacityView } from "#lib/server/cloud-capacity-view.js";

  let { capacity }: { capacity: Promise<CloudCapacityView> } = $props();

  const n = (v: number) => v.toLocaleString("en-US");
</script>

{#await capacity}
  <Card data-testid="cloud-capacity">
    <CardHeader>
      <CardTitle class="text-base">Cloud capacity</CardTitle>
      <CardDescription>Reading the project's Cloud Run CPU quota…</CardDescription>
    </CardHeader>
  </Card>
{:then view}
  {#if view.state === "error"}
    <Card data-testid="cloud-capacity">
      <CardHeader>
        <CardTitle class="text-base">Cloud capacity</CardTitle>
        <CardDescription class="text-destructive" data-testid="cloud-capacity-error">
          {view.message}
        </CardDescription>
      </CardHeader>
    </Card>
  {:else if view.state === "ok"}
    {@const c = view.capacity}
    <Card data-testid="cloud-capacity">
      <CardHeader>
        <CardTitle class="text-base">Cloud capacity</CardTitle>
        <CardDescription>
          How many tasks of the quality check and the search index run at once. Google Cloud sets
          it with project <code>{c.projectId}</code>'s Cloud Run CPU quota in
          <code>{c.region}</code>, read just now.
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4 text-sm">
        <dl class="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
          <dt class="text-muted-foreground">CPU quota</dt>
          <dd data-testid="cloud-capacity-quota">
            {#if c.quotaVcpu === null}
              no limit
            {:else}
              {n(c.quotaVcpu)} vCPU, of which {c.reservedVcpu} stay free for the admin and the site
            {/if}
          </dd>
          <dt class="text-muted-foreground">Quality check</dt>
          <dd data-testid="cloud-capacity-check">
            {c.lighthouseTasks} of up to {view.maxLighthouseTasks} Lighthouse runs at once{#if view.checkRounds > 1}:
              a full check takes about {view.checkRounds} rounds instead of one{/if}
          </dd>
          <dt class="text-muted-foreground">Search index</dt>
          <dd data-testid="cloud-capacity-index">
            {c.indexTasks} of up to {view.maxIndexTasks} tasks for a large build (a first index
            with semantic search, a model change); everyday updates need one
          </dd>
        </dl>

        {#if view.limited}
          <div class="rounded-md border p-3" data-testid="cloud-capacity-speed-up">
            <p class="font-medium">How to make them faster</p>
            <ol class="mt-2 list-decimal space-y-1 pl-5">
              <li>
                Open the
                <a class="underline" href={view.consoleUrl} target="_blank" rel="noopener noreferrer"
                  >Quotas page of project {c.projectId}</a
                > in the Google Cloud console (IAM &amp; Admin → Quotas).
              </li>
              <li>
                Filter for <code>{view.metric}</code> and tick the row for <code>{c.region}</code>.
              </li>
              <li>
                Click <em>Edit quotas</em>, enter <strong>{n(c.fullSpeedVcpu)} vCPU</strong> ({n(
                  c.checkFullSpeedVcpu,
                )} is enough for every quality check at full speed), and send the request with a
                short reason, for example "Parallel quality checks and search index builds of our
                website (Caelo CMS)".
              </li>
              <li>
                Google usually answers within minutes, sometimes within two days. Caelo uses the
                new quota from the next Stage on: nothing else to do.
              </li>
            </ol>
          </div>
        {:else}
          <p class="text-muted-foreground" data-testid="cloud-capacity-full">
            Every job runs at full width.
          </p>
        {/if}
      </CardContent>
    </Card>
  {/if}
{/await}
