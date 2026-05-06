<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { onDestroy } from "svelte";
  import { invalidate } from "$app/navigation";
  import { page } from "$app/stores";
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { buttonVariants } from "$lib/components/ui/button/button-variants.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";

  let { data, form } = $props();

  // Poll while crawling. Every 2s, invalidate the load function so the
  // server re-reads the run status. Stops when status leaves 'crawling'.
  let pollHandle: ReturnType<typeof setInterval> | null = null;
  $effect(() => {
    if (data.step === "crawling") {
      if (pollHandle === null) {
        pollHandle = setInterval(() => {
          invalidate(() => true);
        }, 2000);
      }
    } else if (pollHandle !== null) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  });
  onDestroy(() => {
    if (pollHandle) clearInterval(pollHandle);
  });
</script>

<div class="mx-auto max-w-3xl space-y-6 py-8">
  <div>
    <h1 class="text-3xl font-semibold tracking-tight">Ramp up your site</h1>
    <p class="mt-2 text-base text-muted-foreground">
      Point Caelo at an existing website. The crawler extracts per-page modules + theme tokens; the
      AI synthesises a layout, template, and draft pages. You review and publish — nothing goes live
      automatically.
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}

  <!-- Stepper -->
  <ol class="flex items-center gap-2 text-xs">
    {#each [{ k: "preferences", label: "0. Preferences" }, { k: "welcome", label: "1. URL" }, { k: "crawling", label: "2. Crawling" }, { k: "review", label: "3. Review" }, { k: "done", label: "4. Done" }] as s}
      {@const active = data.step === s.k || (s.k === "done" && form?.composed)}
      <li class="flex items-center gap-2">
        <span class={active ? "rounded-full bg-primary px-3 py-1 text-primary-foreground" : "rounded-full border px-3 py-1 text-muted-foreground"}>
          {s.label}
        </span>
        <span class="text-muted-foreground">→</span>
      </li>
    {/each}
  </ol>

  {#if form?.composed}
    <!-- Step 4 — Done -->
    <Card>
      <CardHeader>
        <CardTitle>Site synthesised ✓</CardTitle>
        <CardDescription>
          {form.pageCount} draft pages created · {form.themeTokensApplied} theme tokens applied · template ready.
          Review and publish via the live editor.
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-wrap gap-2">
        {#if form.homepageId}
          <a class={buttonVariants({ variant: "default" })} href="/edit?page={form.homepageId}">
            Open homepage in live editor →
          </a>
        {/if}
        <a class={buttonVariants({ variant: "outline" })} href="/content/pages">All pages</a>
        <a class={buttonVariants({ variant: "outline" })} href="/security/structured/theme/site">
          Tweak theme tokens
        </a>
      </CardContent>
    </Card>
  {:else if data.step === "preferences"}
    <!-- Step 0 — Preferences. Optional. Each non-empty field becomes
         a `site_ai_memory.set` call so the AI sees the operator's
         intent from turn 1. Skippable; the AI's existing tone fallback
         covers an empty memory. -->
    <Card>
      <CardHeader>
        <CardTitle>Step 0 · Tell Caelo about your site</CardTitle>
        <CardDescription>
          Optional. Whatever you fill in becomes part of the AI's context for every chat. Skip if
          you'd rather set this up later via <code>/security/memory</code>.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" action="?/savePreferences" class="space-y-4">
          <input type="hidden" name="_csrf" value={$page.data.csrfToken} />
          <div class="space-y-2">
            <Label for="purpose">Site purpose</Label>
            <textarea
              id="purpose"
              name="purpose"
              rows="3"
              maxlength="2000"
              class="block w-full rounded-md border bg-background p-2 text-sm"
              placeholder="What is this site for? (e.g. 'developer-facing landing site for the Caelo CMS open-source project')"
              value={data.memory?.purpose ?? ""}
            ></textarea>
          </div>
          <div class="space-y-2">
            <Label for="brandVoice">Brand voice / tone</Label>
            <textarea
              id="brandVoice"
              name="brandVoice"
              rows="3"
              maxlength="2000"
              class="block w-full rounded-md border bg-background p-2 text-sm"
              placeholder="How should the AI write? (e.g. 'confident, plainspoken, slightly technical; no exclamation marks; favour active voice')"
              value={data.memory?.brandVoice ?? ""}
            ></textarea>
          </div>
          <div class="space-y-2">
            <Label for="bannedPhrases">Words to avoid</Label>
            <textarea
              id="bannedPhrases"
              name="bannedPhrases"
              rows="2"
              maxlength="2000"
              class="block w-full rounded-md border bg-background p-2 text-sm"
              placeholder="Comma-separated terms the AI should NOT use (e.g. 'cutting-edge, leverage, synergy, world-class')"
              value={data.memory?.bannedPhrases ?? ""}
            ></textarea>
          </div>
          <div class="flex items-center justify-between pt-2">
            <a class={buttonVariants({ variant: "ghost" })} href="/ramp-up?step=url">
              Skip — set up later
            </a>
            <Button type="submit">Save & continue →</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  {:else if data.step === "welcome"}
    <!-- Step 1 — URL input -->
    <Card>
      <CardHeader>
        <CardTitle>Step 1 · Source URL</CardTitle>
        <CardDescription>
          Paste the URL of a site you'd like to base your new Caelo install on. The crawler walks
          same-domain links up to <code>maxPages</code> pages with polite throttling.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" action="?/start" class="space-y-4">
          <input type="hidden" name="_csrf" value={$page.data.csrfToken} />
          <div class="space-y-2">
            <Label for="sourceUrl">Source URL</Label>
            <Input
              id="sourceUrl"
              name="sourceUrl"
              type="url"
              required
              placeholder="https://example.com"
            />
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-2">
              <Label for="depth">Crawl depth</Label>
              <Input id="depth" name="depth" type="number" min="1" max="5" value="2" />
              <p class="text-xs text-muted-foreground">Links followed from the entry URL (1–5).</p>
            </div>
            <div class="space-y-2">
              <Label for="maxPages">Max pages</Label>
              <Input id="maxPages" name="maxPages" type="number" min="1" max="500" value="20" />
              <p class="text-xs text-muted-foreground">Crawler stops at this many extracted pages.</p>
            </div>
          </div>
          <Button type="submit">Start crawl →</Button>
        </form>
      </CardContent>
    </Card>
  {:else if data.step === "crawling"}
    <!-- Step 2 — Crawling -->
    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          Step 2 · Crawling
          <Badge variant="outline">{data.run?.status}</Badge>
        </CardTitle>
        <CardDescription>
          The worker picks up new runs every ~10s. This page polls every 2s and advances
          automatically when extraction finishes.
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-2 text-sm">
        <p>Source: <code>{data.run?.sourceUrl}</code></p>
        <p>Pages seen: {data.run?.pagesSeen ?? 0}</p>
        <p>Pages extracted: {data.run?.pagesExtracted ?? 0}</p>
        {#if data.run?.errorMessage}
          <p class="text-red-700 dark:text-red-300">Error: {data.run.errorMessage}</p>
        {/if}
      </CardContent>
    </Card>
  {:else if data.step === "review" && data.run && data.pages}
    <!-- Step 3 — Review -->
    <Card>
      <CardHeader>
        <CardTitle>Step 3 · Review extracted pages</CardTitle>
        <CardDescription>
          {data.pages.length} pages staged from <code>{data.run.sourceUrl}</code>. Click "Synthesise
          site" to materialise them as drafts (AI aggregates theme tokens, creates a template, and
          turns each staged page into a draft you can edit and publish).
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">
        {#each data.pages as p}
          <div class="flex items-center justify-between rounded border p-3 text-sm">
            <div>
              <span class="font-mono">/{p.proposedSlug}</span>
              <span class="ml-2 text-muted-foreground">{p.proposedTitle}</span>
              <span class="ml-2 text-xs text-muted-foreground">
                ({p.proposedModules.length} modules)
              </span>
            </div>
            <div class="flex items-center gap-2">
              {#if p.acceptedPageId}
                <Badge variant="secondary">already accepted</Badge>
              {:else if p.diffStatus === "fail"}
                <Badge variant="destructive">screenshot diff: fail</Badge>
              {:else if p.diffStatus === "warn"}
                <Badge variant="outline">diff: warn</Badge>
              {:else if p.diffStatus === "pass"}
                <Badge>diff: pass</Badge>
              {/if}
            </div>
          </div>
        {/each}
        <form method="post" action="?/compose" class="pt-2">
          <input type="hidden" name="_csrf" value={$page.data.csrfToken} />
          <input type="hidden" name="runId" value={data.run.id} />
          <Button type="submit">Synthesise site →</Button>
        </form>
      </CardContent>
    </Card>
  {:else if data.step === "failed" && data.run}
    <!-- Failed -->
    <Card>
      <CardHeader>
        <CardTitle>Crawl failed</CardTitle>
        <CardDescription>
          {data.run.errorMessage ?? "The worker stopped before extraction completed."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <a class={buttonVariants({ variant: "outline" })} href="/ramp-up">Start over</a>
      </CardContent>
    </Card>
  {/if}
</div>
