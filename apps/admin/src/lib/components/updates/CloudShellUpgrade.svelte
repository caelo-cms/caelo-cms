<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * #696 maintainer decision 1, #861 — the break-glass way to install a
   * release: once, with the Owner's own Google account, in Google Cloud
   * Shell. The admin is deliberately not allowed to change the project's
   * permissions, so a release it cannot install itself runs there.
   *
   * Card-less: the page's status card holds it as its primary action in the
   * `break_glass` state (`prominent`), and "Other ways to install" holds it
   * as a secondary one. The one-click Cloud Shell link opens the release's
   * walkthrough; the pinned commands are the copyable alternative.
   */

  import { ExternalLink } from "lucide-svelte";
  import { buttonVariants } from "#lib/components/ui/button/button-variants.js";
  import CopyLine from "./CopyLine.svelte";

  let {
    version,
    reason = null,
    consoleUrl,
    commands,
    prominent = false,
  }: {
    version: string;
    /** Why the upgrader stopped (its own words), when it did. */
    reason?: string | null;
    consoleUrl: string | null;
    commands: readonly string[];
    /** The page's primary action (break-glass); otherwise an outline button. */
    prominent?: boolean;
  } = $props();
</script>

<div class="space-y-4 text-sm" data-testid="cloud-shell-upgrade">
  {#if reason}
    <p class="text-muted-foreground" data-testid="cloud-shell-reason">{reason}</p>
  {/if}
  <div class="space-y-1">
    <p class="font-medium">What happens</p>
    <ol class="list-decimal space-y-1 pl-5 text-muted-foreground">
      <li>
        Cloud Shell opens: a terminal in your browser, provided by Google and already signed in as
        you, with Caelo's step-by-step walkthrough. Nothing is installed on your computer.
      </li>
      <li>You follow the walkthrough (or paste the commands below, one after the other).</li>
      <li>
        They check the release is genuine, back up your database, apply what the release needs in
        your Google Cloud project, then switch your site to v{version} and test it — and go back
        automatically if the test fails.
      </li>
    </ol>
    <p class="text-muted-foreground">
      The admin is deliberately not allowed to change your project's permissions: even someone who
      took over the admin could not. That is why this step runs with your own Google account.
    </p>
  </div>
  <p class="text-muted-foreground">
    About 10 to 20 minutes. Your public site stays online. Cloud Shell itself is free; anything the
    release adds to your Google Cloud bill is named in its release notes.
  </p>
  {#if consoleUrl}
    <a
      href={consoleUrl}
      target="_blank"
      rel="noopener noreferrer"
      class={buttonVariants({ variant: prominent ? "default" : "outline" })}
      data-testid="open-cloud-shell"
    >
      Open Google Cloud Shell <ExternalLink class="size-4" aria-hidden="true" />
    </a>
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
</div>
