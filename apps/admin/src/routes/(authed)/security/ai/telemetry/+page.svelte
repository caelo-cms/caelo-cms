<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import { Label } from "$lib/components/ui/label/index.js";

  let { data, form } = $props();
  // P16 hardening — preview text lives in component-local state only;
  // never round-trips through the SvelteKit hydration cache.
  let previewText = $state("");
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Telemetry</h1>
    <p class="text-sm text-muted-foreground">
      Caelo telemetry is <strong>off by default</strong> and never transmits before opt-in. The
      install id is minted only when at least one flag flips on. Click "Test send" to inspect the
      exact payload before opting in. P17 wires the actual collector — until then, both flags
      cause locally-buffered counts only.
    </p>
    <div class="mt-3 text-sm">
      <a class="underline" href="/security/ai">← AI providers</a>
    </div>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok && form?.installId !== undefined}
    <Alert>
      <AlertDescription>
        Saved. Install id: <code>{form.installId ?? "not minted (both flags off)"}</code>
      </AlertDescription>
    </Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Settings</CardTitle>
      <CardDescription>
        Current install id: <code
          >{data.settings.installId ?? "<not yet minted — opt-in not active>"}</code
        >. Events sent: {data.settings.eventsSentCount}. Last sent: {data.settings.lastSentAt ??
          "—"}.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/set" class="space-y-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <div class="flex items-start gap-3">
          <input
            id="installPingEnabled"
            name="installPingEnabled"
            type="checkbox"
            value="1"
            checked={data.settings.installPingEnabled}
            class="mt-1"
          />
          <div class="space-y-1">
            <Label for="installPingEnabled" class="font-medium">Install ping</Label>
            <p class="text-xs text-muted-foreground">
              Sends a daily heartbeat with installId + Caelo version + counts (pages / modules /
              active plugins). Never page or module content. Never user data.
            </p>
          </div>
        </div>
        <div class="flex items-start gap-3">
          <input
            id="errorReportingEnabled"
            name="errorReportingEnabled"
            type="checkbox"
            value="1"
            checked={data.settings.errorReportingEnabled}
            class="mt-1"
          />
          <div class="space-y-1">
            <Label for="errorReportingEnabled" class="font-medium">Error reporting</Label>
            <p class="text-xs text-muted-foreground">
              Sends server-side unhandled errors with stack trace + request id. Never request body,
              never headers, never form data.
            </p>
          </div>
        </div>
        <Button type="submit">Save</Button>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Test send</CardTitle>
      <CardDescription>
        Builds the payload that WOULD be sent. Does not transmit. Audit before opting in. The
        payload renders below — it is NOT cached into the page hydration state, so it disappears on
        navigation. Re-click to inspect again.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <button
        type="button"
        class="border-input bg-background hover:bg-accent inline-flex h-9 items-center justify-center rounded-md border px-4 text-sm font-medium"
        onclick={async () => {
          const r = await fetch("/security/ai/telemetry/preview", { method: "POST" });
          previewText = r.ok ? await r.text() : `Error: ${r.status}`;
        }}>Build test payload</button
      >
      {#if previewText}
        <pre class="mt-4 overflow-x-auto rounded-md bg-muted p-3 text-xs"><code>{previewText}</code></pre>
      {/if}
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Privacy summary</CardTitle>
    </CardHeader>
    <CardContent class="space-y-2 text-sm">
      <p>
        <Badge variant="success">Sent</Badge> Caelo version, installId (UUID), aggregate counts.
      </p>
      <p>
        <Badge variant="destructive">NEVER sent</Badge> page content, module content, user names,
        emails, IP addresses, request bodies, AI prompts, AI responses, OAuth secrets, env vars.
      </p>
      <p class="text-muted-foreground">
        See <code>docs/TELEMETRY.md</code> for the full policy.
      </p>
    </CardContent>
  </Card>
</div>
