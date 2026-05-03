<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Mail } from "lucide-svelte";
  import { enhance } from "$app/forms";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import { Input } from "$lib/components/ui/input/index.js";

  let { data, form } = $props();

  type Transport = "none" | "smtp" | "resend" | "ses";
  let transport = $state<Transport>(data.config.transport);
  let fromAddress = $state(data.config.fromAddress);
  let apiKey = $state((data.config.config?.apiKey as string | undefined) ?? "");
  let smtpHost = $state((data.config.config?.host as string | undefined) ?? "");
  let smtpPort = $state(((data.config.config?.port as number | undefined) ?? 587).toString());
  let smtpSecure = $state(Boolean(data.config.config?.secure));
  let smtpUser = $state((data.config.config?.user as string | undefined) ?? "");
  let smtpPass = $state((data.config.config?.pass as string | undefined) ?? "");
</script>

<div class="space-y-6">
  <div>
    <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <Mail class="size-6" />
      Email transport
    </h1>
    <p class="text-sm text-muted-foreground">
      Plugins that declare the <code>email</code> capability (newsletter, auth password reset)
      dispatch through this transport. Until you switch off <code>none</code>, sends are logged
      to stderr and not delivered.
    </p>
  </div>

  {#if form?.error}
    <div class="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">{form.error}</div>
  {/if}
  {#if form?.ok}
    <div class="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-700 dark:bg-green-950 dark:text-green-300">{form.message}</div>
  {/if}
  {#if data.error}
    <div class="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">Could not load existing config: {data.error}</div>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle>Transport configuration</CardTitle>
      <CardDescription>Last updated {new Date(data.config.updatedAt).toLocaleString()}.</CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/save" use:enhance class="grid gap-4 max-w-xl">
        <label class="grid gap-1 text-sm">
          <span>Transport</span>
          <select bind:value={transport} name="transport" class="rounded border px-3 py-2 text-sm">
            <option value="none">None (no-op stub — logs to stderr)</option>
            <option value="resend">Resend (recommended for production)</option>
            <option value="smtp" disabled>SMTP (lands in P15)</option>
            <option value="ses" disabled>AWS SES (lands in P15)</option>
          </select>
        </label>
        <label class="grid gap-1 text-sm">
          <span>From address</span>
          <Input name="fromAddress" type="email" bind:value={fromAddress} placeholder="hello@example.com" />
        </label>

        {#if transport === "resend"}
          <label class="grid gap-1 text-sm">
            <span>Resend API key</span>
            <Input name="apiKey" type="password" bind:value={apiKey} autocomplete="off" />
            <span class="text-xs text-muted-foreground">Stored as plain JSON in cms_admin; rotate via this UI.</span>
          </label>
        {:else if transport === "smtp"}
          <div class="grid grid-cols-3 gap-2">
            <label class="col-span-2 grid gap-1 text-sm">
              <span>SMTP host</span>
              <Input name="smtpHost" bind:value={smtpHost} placeholder="smtp.example.com" />
            </label>
            <label class="grid gap-1 text-sm">
              <span>Port</span>
              <Input name="smtpPort" type="number" bind:value={smtpPort} />
            </label>
          </div>
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" name="smtpSecure" bind:checked={smtpSecure} />
            <span>Use TLS</span>
          </label>
          <label class="grid gap-1 text-sm">
            <span>Username (optional)</span>
            <Input name="smtpUser" bind:value={smtpUser} autocomplete="off" />
          </label>
          <label class="grid gap-1 text-sm">
            <span>Password (optional)</span>
            <Input name="smtpPass" type="password" bind:value={smtpPass} autocomplete="off" />
          </label>
          <p class="text-xs text-amber-700 dark:text-amber-400">
            SMTP transport is a placeholder — saving works, but plugin sends will throw. Use Resend
            until SMTP/SES adapters land.
          </p>
        {/if}

        <div>
          <Button type="submit">Save transport</Button>
        </div>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle>Send test email</CardTitle>
      <CardDescription>
        Confirms the saved transport actually delivers. Save your config above first.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/testSend" use:enhance class="grid gap-3 max-w-md">
        <label class="grid gap-1 text-sm">
          <span>Recipient</span>
          <Input name="to" type="email" placeholder="you@example.com" required />
        </label>
        <div>
          <Button type="submit" variant="secondary">Send test email</Button>
        </div>
      </form>
    </CardContent>
  </Card>
</div>
