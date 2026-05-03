<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Activity, KeyRound, Shield } from "lucide-svelte";
  import { enhance } from "$app/forms";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/components/ui/table/index.js";

  let { data, form } = $props();
  let maxBodyBytes = $state(data.settings.maxBodyBytes);
  let autoRedeployEnabled = $state(data.settings.autoRedeployEnabled);
  let debounceMs = $state(data.settings.autoRedeployDebounceMs);
  let captchaProvider = $state(data.settings.captchaProvider);
  let captchaPowTargetPrefix = $state(data.settings.captchaPowTargetPrefix);

  function fmtTime(s: string): string {
    return new Date(s).toLocaleString();
  }
  function statusVariant(code: number): "default" | "secondary" | "destructive" | "outline" {
    if (code >= 500) return "destructive";
    if (code >= 400) return "outline";
    return "default";
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <Shield class="size-6" />
      Gateway
    </h1>
    <p class="text-sm text-muted-foreground">
      Public-write hardening: body-size cap, signed cookies, rate-limit, captcha provider,
      honeypot, request log. AI-proposed rate-limit changes land at
      <a href="/security/gateway/pending" class="underline">/security/gateway/pending</a>.
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
      <CardTitle>Settings</CardTitle>
      <CardDescription>
        Last updated {fmtTime(data.settings.updatedAt)} · cookie secret {data.settings.cookieSecretSet ? "configured" : "missing (auto-generated on next request)"}.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/saveSettings" use:enhance class="grid gap-4 max-w-xl">
        <label class="grid gap-1 text-sm">
          <span>Max body bytes (512–1,048,576)</span>
          <Input name="maxBodyBytes" type="number" min={512} max={1048576} bind:value={maxBodyBytes} required />
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" name="autoRedeployEnabled" bind:checked={autoRedeployEnabled} />
          <span>Auto-redeploy on publishable events</span>
        </label>
        <label class="grid gap-1 text-sm">
          <span>Auto-redeploy debounce (ms)</span>
          <Input name="debounceMs" type="number" min={1000} max={600000} bind:value={debounceMs} required />
        </label>
        <label class="grid gap-1 text-sm">
          <span>Captcha provider</span>
          <select bind:value={captchaProvider} name="captchaProvider" class="rounded border px-3 py-2 text-sm">
            <option value="off">Off (visitors not challenged)</option>
            <option value="pow">PoW (default — zero-config)</option>
            <option value="turnstile" disabled>Cloudflare Turnstile (P15)</option>
            <option value="hcaptcha" disabled>hCaptcha (P15)</option>
          </select>
        </label>
        <label class="grid gap-1 text-sm">
          <span>PoW target prefix (hex; longer = harder)</span>
          <Input name="captchaPowTargetPrefix" bind:value={captchaPowTargetPrefix} required />
          <span class="text-xs text-muted-foreground">000fff ≈ 50ms on a laptop. 0000ff ≈ 800ms.</span>
        </label>
        <div>
          <Button type="submit">Save settings</Button>
        </div>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="flex items-center gap-2"><KeyRound class="size-4" /> Cookie secret</CardTitle>
      <CardDescription>
        Rotating invalidates every visitor + visitor-session cookie. Users re-login on next request.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/rotateSecret" use:enhance>
        <Button type="submit" variant="destructive">Rotate cookie secret</Button>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <div class="flex items-center justify-between">
        <div>
          <CardTitle class="flex items-center gap-2"><Activity class="size-4" /> Recent requests</CardTitle>
          <CardDescription>
            {data.requests.length} shown. <a href={data.onlyErrors ? "?" : "?errors=1"} class="underline">{data.onlyErrors ? "show all" : "show errors only"}</a>
          </CardDescription>
        </div>
      </div>
    </CardHeader>
    <CardContent>
      {#if data.requests.length === 0}
        <p class="text-sm text-muted-foreground">No gateway traffic yet.</p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Plugin · op</TableHead>
              <TableHead>Status</TableHead>
              <TableHead class="text-right">ms</TableHead>
              <TableHead class="text-right">bytes</TableHead>
              <TableHead>Flags</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.requests as r (r.id)}
              <TableRow>
                <TableCell class="whitespace-nowrap text-xs">{fmtTime(r.createdAt)}</TableCell>
                <TableCell class="font-mono text-xs">{r.pluginSlug}.{r.operation}</TableCell>
                <TableCell><Badge variant={statusVariant(r.statusCode)}>{r.statusCode}</Badge></TableCell>
                <TableCell class="text-right text-xs">{r.durationMs}</TableCell>
                <TableCell class="text-right text-xs">{r.bodyBytes}</TableCell>
                <TableCell class="space-x-1 text-xs">
                  {#if r.wasRateLimited}<Badge variant="outline">429</Badge>{/if}
                  {#if r.wasHoneypotCaught}<Badge variant="outline">honeypot</Badge>{/if}
                  {#if r.captchaPassed}<Badge variant="outline">captcha</Badge>{/if}
                  {#if r.errorKind}<Badge variant="destructive">{r.errorKind}</Badge>{/if}
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
      <CardTitle>Per-(plugin, operation) rate limit override</CardTitle>
      <CardDescription>Owner-direct write. AI proposals: <a href="/security/gateway/pending" class="underline">/security/gateway/pending</a>.</CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/setOverride" use:enhance class="grid gap-3 max-w-xl md:grid-cols-2">
        <label class="grid gap-1 text-sm">
          <span>Plugin slug</span>
          <Input name="pluginSlug" placeholder="forms" required />
        </label>
        <label class="grid gap-1 text-sm">
          <span>Operation</span>
          <Input name="operation" placeholder="submit" required />
        </label>
        <label class="grid gap-1 text-sm">
          <span>Max per visitor</span>
          <Input name="perVisitorMax" type="number" min={1} max={100000} required />
        </label>
        <label class="grid gap-1 text-sm">
          <span>Window seconds</span>
          <Input name="windowSeconds" type="number" min={1} max={3600} required />
        </label>
        <div class="md:col-span-2">
          <Button type="submit">Save override</Button>
        </div>
      </form>
    </CardContent>
  </Card>
</div>
