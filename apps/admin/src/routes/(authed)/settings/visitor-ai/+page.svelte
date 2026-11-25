<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * #1654 — Settings → Visitor AI. The settings the AI can also propose
   * (propose_set_visitor_ai), the key of each environment (paste, rotate,
   * remove; never shown) and what visitors spent. The spend comes from the
   * gateway's own ledger, which the public side writes: shown as reported.
   */

  import { Bot } from "lucide-svelte";
  import { enhance } from "$app/forms";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Select } from "#lib/components/ui/select/index.js";

  let { data, form } = $props();

  const s = $derived(data.settings);
  let keyProvider = $state(data.settings.provider);

  function usd(v: number): string {
    return v < 0.01 && v > 0 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
  }
  function keyLine(k: { provider: string | null; setAt: string | null }): string {
    return k.provider ? `${k.provider} key, stored ${new Date(k.setAt ?? "").toLocaleString()}` : "no key";
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <Bot class="size-6" />
      Visitor AI
    </h1>
    <p class="max-w-2xl text-sm text-muted-foreground">
      The AI that answers your visitors' questions from your site's pages, through a plugin such as
      a site assistant. It runs on a key of its own, never the one the editor's AI uses, and only
      within the budgets below. It can search and read your site, nothing else.
    </p>
  </div>

  {#if form?.error}
    <div class="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">{form.error}</div>
  {/if}
  {#if form?.ok}
    <div class="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-700 dark:bg-green-950 dark:text-green-300">{form.message}</div>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="flex items-center gap-2">
        Status
        {#if data.blocked}
          <Badge variant="warning" data-testid="visitor-ai-status">Not running</Badge>
        {:else}
          <Badge variant="success" data-testid="visitor-ai-status">Answering visitors</Badge>
        {/if}
      </CardTitle>
      <CardDescription>
        {data.blocked ? `Visitors are told the assistant is unavailable: ${data.blocked}.` : "Visitors' questions are answered."}
      </CardDescription>
    </CardHeader>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle>Keys</CardTitle>
      <CardDescription>
        Live site: {keyLine(data.keys.live)}. Staging: {keyLine(data.keys.staging)}. A stored key is
        never shown again — not to you, not to the AI. {data.providerLimitHint}
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-6">
      <form method="post" action="?/storeKey" use:enhance class="grid max-w-xl gap-3" autocomplete="off">
        <div class="grid gap-1">
          <Label for="key-provider">Provider</Label>
          <Select id="key-provider" name="provider" bind:value={keyProvider}>
            {#each data.providers as p (p)}<option value={p}>{p}</option>{/each}
          </Select>
        </div>
        <div class="grid gap-1">
          <Label for="key-value">API key</Label>
          <Input id="key-value" name="apiKey" type="password" required minlength={20} autocomplete="off" />
          <p class="text-xs text-muted-foreground">
            Checked with the provider first, then stored where only the gateway reads it. Storing a
            new key replaces the old one (rotate), then revoke the old one at the provider.
          </p>
        </div>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" name="staging" value="same" checked />
          Also use this key on staging (otherwise staging's assistant stays unavailable)
        </label>
        <Button type="submit" class="w-fit">Store key</Button>
      </form>
      <form method="post" action="?/removeKey" use:enhance class="flex items-center gap-2">
        <input type="hidden" name="environment" value="both" />
        <Button type="submit" variant="outline" disabled={!data.keys.live.provider && !data.keys.staging.provider}>Remove both keys</Button>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle>Settings</CardTitle>
      <CardDescription>
        Budgets bind both gateways at the next question. Running conversations count at the most
        they could cost until they end, so a budget is never exceeded.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/save" use:enhance class="grid max-w-xl gap-4">
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" name="enabled" checked={s.enabled} />
          Answer visitors
        </label>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="grid gap-1">
            <Label for="provider">Provider</Label>
            <Select id="provider" name="provider" value={s.provider}>
              {#each data.providers as p (p)}<option value={p}>{p}</option>{/each}
            </Select>
          </div>
          <div class="grid gap-1">
            <Label for="model">Model</Label>
            <Input id="model" name="model" value={s.model} required />
          </div>
          <div class="grid gap-1">
            <Label for="daily">Budget per 24 hours (USD)</Label>
            <Input id="daily" name="dailyBudgetUsd" type="number" step="0.01" min="0" value={s.dailyBudgetUsd} />
          </div>
          <div class="grid gap-1">
            <Label for="monthly">Budget per 30 days (USD)</Label>
            <Input id="monthly" name="monthlyBudgetUsd" type="number" step="0.01" min="0" value={s.monthlyBudgetUsd} />
          </div>
          <div class="grid gap-1">
            <Label for="conversation">Per conversation (USD)</Label>
            <Input id="conversation" name="conversationBudgetUsd" type="number" step="0.01" min="0" value={s.conversationBudgetUsd} />
          </div>
          <div class="grid gap-1">
            <Label for="staging">Staging per 24 hours (USD)</Label>
            <Input id="staging" name="stagingDailyBudgetUsd" type="number" step="0.01" min="0" value={s.stagingDailyBudgetUsd} />
          </div>
          <div class="grid gap-1">
            <Label for="concurrent">Conversations at once</Label>
            <Input id="concurrent" name="maxConcurrent" type="number" min="1" max="500" value={s.maxConcurrent} />
          </div>
          <div class="grid gap-1">
            <Label for="turns">Questions per conversation (empty: the plugin's)</Label>
            <Input id="turns" name="maxTurns" type="number" min="1" max="20" value={s.maxTurns ?? ""} />
          </div>
          <div class="grid gap-1">
            <Label for="chars">Characters per question (empty: the plugin's)</Label>
            <Input id="chars" name="maxQuestionChars" type="number" min="20" max="2000" value={s.maxQuestionChars ?? ""} />
          </div>
          <div class="grid gap-1">
            <Label for="tokens">Answer length in tokens (empty: the plugin's)</Label>
            <Input id="tokens" name="maxAnswerTokens" type="number" min="64" max="2000" value={s.maxAnswerTokens ?? ""} />
          </div>
        </div>
        <Button type="submit" class="w-fit">Save</Button>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle>What visitors spent (live site)</CardTitle>
      <CardDescription>
        As the gateway's ledger reports it{data.spend?.dropped ? `; ${data.spend.dropped} malformed rows were ignored` : ""}.
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.spend}
        <p class="text-sm" data-testid="visitor-ai-spend">
          {usd(data.spend.last24hUsd)} in the last 24 hours, {usd(data.spend.last30dUsd)} in the last 30 days.
        </p>
        {#if data.spend.perOperation.length > 0}
          <ul class="mt-2 divide-y rounded-md border text-sm">
            {#each data.spend.perOperation as r (`${r.pluginId}:${r.operation}`)}
              <li class="flex justify-between px-3 py-2">
                <span class="font-mono text-xs">{r.operation}</span>
                <span>{r.turns} answers{r.running > 0 ? `, ${r.running} running` : ""} · {usd(r.last30dUsd)}</span>
              </li>
            {/each}
          </ul>
        {/if}
      {:else}
        <p class="text-sm text-muted-foreground">The ledger could not be read: {data.spendError}</p>
      {/if}
    </CardContent>
  </Card>
</div>
