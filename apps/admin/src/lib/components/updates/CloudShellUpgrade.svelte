<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * #696 maintainer decision 1 — a release that changes the install's cloud
   * setup is installed with the Owner's own Google account in Cloud Shell,
   * never by the admin's upgrader. This card explains why, what happens and
   * what it costs, links Cloud Shell on the install's project, and gives the
   * pinned commands to paste there (the one-click flow is #696 Phase 3).
   */

  import { ExternalLink, Terminal } from "lucide-svelte";
  import { buttonVariants } from "#lib/components/ui/button/button-variants.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";
  import CopyLine from "./CopyLine.svelte";

  let {
    version,
    reason,
    consoleUrl,
    commands,
  }: { version: string; reason: string | null; consoleUrl: string | null; commands: readonly string[] } =
    $props();
</script>

<Card data-testid="cloud-shell-upgrade">
  <CardHeader>
    <CardTitle class="flex items-center gap-2 text-base">
      <Terminal class="size-4" aria-hidden="true" />
      v{version} needs one step in Google Cloud Shell
    </CardTitle>
    <CardDescription>Nothing was changed on your site.</CardDescription>
  </CardHeader>
  <CardContent class="space-y-4 text-sm">
    <div class="space-y-1">
      <p class="font-medium">Why</p>
      {#if reason}<p data-testid="cloud-shell-reason">{reason}</p>{/if}
      <p class="text-muted-foreground">
        This release changes how your Google Cloud project is set up (for example who may do what in
        it). The admin is deliberately not allowed to change that — even if someone took over the
        admin, they could not change your project's permissions. So this update runs once with your
        own Google account.
      </p>
    </div>
    <div class="space-y-1">
      <p class="font-medium">What happens</p>
      <ol class="list-decimal space-y-1 pl-5 text-muted-foreground">
        <li>
          Cloud Shell opens: a terminal in your browser, provided by Google and already signed in as
          you, with Caelo's step-by-step walkthrough. Nothing is installed on your computer.
        </li>
        <li>You follow the walkthrough (or paste the commands below, one after the other).</li>
        <li>
          They check the release is genuine, back up your database, apply the cloud changes, then
          switch your site to v{version} and test it — and go back automatically if the test fails.
        </li>
      </ol>
    </div>
    <div class="space-y-1">
      <p class="font-medium">Time and cost</p>
      <p class="text-muted-foreground">
        About 10 to 20 minutes. Your public site stays online. Cloud Shell itself is free; anything the
        release adds to your Google Cloud bill is named in its release notes.
      </p>
    </div>
    {#if consoleUrl}
      <a
        href={consoleUrl}
        target="_blank"
        rel="noopener noreferrer"
        class={buttonVariants({ variant: "default" })}
        data-testid="open-cloud-shell"
      >
        Open Cloud Shell <ExternalLink class="size-4" aria-hidden="true" />
      </a>
      <p class="text-xs text-muted-foreground">
        Cloud Shell opens Caelo's walkthrough for v{version}; it checks the release is genuine before
        it runs anything. If you prefer, paste the commands below instead.
      </p>
    {/if}
    <div class="space-y-2">
      <p class="font-medium">{consoleUrl ? "Or paste these, in order" : "Paste these, in order"}</p>
      {#each commands as command, i (command)}
        <CopyLine value={command} label={`Command ${i + 1}`} testid="cloud-shell-command" />
      {/each}
      <p class="text-xs text-muted-foreground">
        The same commands work in a terminal on the computer you installed Caelo from.
      </p>
    </div>
  </CardContent>
</Card>
