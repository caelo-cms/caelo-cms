<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * #696 maintainer decision 1, #816 — the break-glass way to install a
   * release: once, with the Owner's own Google account, in Google Cloud
   * Shell. The admin is deliberately not allowed to change the project's
   * permissions, so a release it cannot install itself runs there.
   *
   * One button and one line (upgrade-path.ts cloudShellUpgrade): the button
   * opens the release's upgrade walkthrough — never the install wizard —
   * and the line is the one command that walkthrough runs. A release whose
   * branch has no walkthrough gets no button; the line is then the CLI's
   * upgrade command for the computer Caelo was installed from.
   *
   * Card-less: the page's status card holds it as its primary action in the
   * `break_glass` state (`prominent`), and "Other ways to install" holds it
   * as a secondary one.
   */

  import { ExternalLink } from "lucide-svelte";
  import { buttonVariants } from "#lib/components/ui/button/button-variants.js";
  import CopyLine from "./CopyLine.svelte";

  let {
    version,
    reason = null,
    consoleUrl,
    command,
    prominent = false,
  }: {
    version: string;
    /** Why the upgrader stopped (its own words), when it did. */
    reason?: string | null;
    consoleUrl: string | null;
    command: string;
    /** The page's primary action (break-glass); otherwise an outline button. */
    prominent?: boolean;
  } = $props();
</script>

<div class="space-y-4 text-sm" data-testid="cloud-shell-upgrade">
  {#if reason}
    <p class="text-muted-foreground" data-testid="cloud-shell-reason">{reason}</p>
  {/if}
  {#if consoleUrl}
    <div class="space-y-1">
      <p class="font-medium">What happens</p>
      <ol class="list-decimal space-y-1 pl-5 text-muted-foreground">
        <li>
          Cloud Shell opens: a terminal in your browser, provided by Google and signed in as you,
          with Caelo's upgrade walkthrough beside it. Nothing is installed on your computer. If
          Google asks whether to trust the repository, confirm it.
        </li>
        <li>
          The walkthrough shows one command. Run it, and confirm with your Google account if Cloud
          Shell asks.
        </li>
        <li>
          It checks that its tools and the release are genuine, finds your site in your Google
          Cloud project, backs up your database, applies what v{version} needs in the project,
          switches your site to v{version} and tests it. If the test fails, your site goes back to
          the version it runs now.
        </li>
      </ol>
      <p class="text-muted-foreground">
        The admin is deliberately not allowed to change your project's permissions: even someone
        who took over the admin could not. That is why this step runs with your own Google account.
      </p>
    </div>
    <p class="text-muted-foreground">
      About 10 to 20 minutes. Your public site stays online. Cloud Shell itself is free; anything
      the release adds to your Google Cloud bill is named in its release notes.
    </p>
    <a
      href={consoleUrl}
      target="_blank"
      rel="noopener noreferrer"
      class={buttonVariants({ variant: prominent ? "default" : "outline" })}
      data-testid="open-cloud-shell"
    >
      Open Google Cloud Shell <ExternalLink class="size-4" aria-hidden="true" />
    </a>
    <div class="space-y-2">
      <p class="font-medium">The command the walkthrough runs</p>
      <CopyLine value={command} label="Upgrade command" testid="cloud-shell-command" />
      <p class="text-xs text-muted-foreground">
        It names this site, for a Google account with more than one Caelo install.
      </p>
    </div>
  {:else}
    <div class="space-y-2">
      <p class="text-muted-foreground">
        v{version} has no Cloud Shell walkthrough. Run this in a terminal on the computer you
        installed Caelo from: it checks the release is genuine, backs up your database, applies what
        the release needs in your Google Cloud project, switches your site to v{version} and tests
        it, and goes back if the test fails.
      </p>
      <CopyLine value={command} label="Upgrade command" testid="cloud-shell-command" />
    </div>
  {/if}
</div>
