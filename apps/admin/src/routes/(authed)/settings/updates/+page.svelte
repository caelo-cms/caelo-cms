<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * #696 Phase 0 — Settings → Updates. Versions + release notes for
   * everyone with settings.read; the pinned upgrade command (with a copy
   * button and a plain-language account of what it does) for those who
   * may run it. See +page.server.ts and #lib/upgrade-path.ts.
   */

  import { Check, Copy } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import { Alert, AlertDescription, AlertTitle } from "#lib/components/ui/alert/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";
  import { releaseNotesExcerpt } from "#lib/upgrade-path.js";

  let { data } = $props();

  const status = $derived(data.status);
  const notes = $derived(
    status.releaseNotes ? releaseNotesExcerpt(status.releaseNotes) : null,
  );
  let copied = $state(false);

  function day(iso: string | null): string | null {
    return iso ? iso.slice(0, 10) : null;
  }

  async function copyCommand(command: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      copied = true;
      toast.success("Upgrade command copied — paste it into your terminal.");
      setTimeout(() => (copied = false), 2000);
    } catch {
      toast.error("Could not copy. Select the command and copy it by hand.");
    }
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Caelo updates</h1>
    <p class="text-sm text-muted-foreground">
      Which version of Caelo your site runs, what the newest release changes, and how to install it.
    </p>
  </div>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Your version</CardTitle>
    </CardHeader>
    <CardContent class="space-y-2 text-sm">
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-mono text-lg" data-testid="installed-version">v{status.installedVersion}</span>
        {#if status.upgradeAvailable}
          <Badge variant="warning">Update available</Badge>
        {:else if status.latestVersion}
          <Badge variant="success">Up to date</Badge>
        {/if}
      </div>
      {#if status.latestVersion === null}
        <p class="text-muted-foreground" data-testid="release-check-unknown">
          {#if status.checkedAt === null}
            Caelo checks for new releases once an hour and hasn't checked yet. Come back in a few
            minutes.
          {:else}
            The last check for new releases ({day(status.checkedAt)}) couldn't reach GitHub. Caelo
            tries again every hour.
          {/if}
        </p>
      {:else if status.checkedAt}
        <p class="text-muted-foreground">Last checked for new releases on {day(status.checkedAt)}.</p>
      {/if}
    </CardContent>
  </Card>

  {#if status.latestVersion}
    <Card>
      <CardHeader>
        <CardTitle class="text-base">
          Newest release: <span class="font-mono" data-testid="latest-version">v{status.latestVersion}</span>
        </CardTitle>
        {#if status.publishedAt}
          <CardDescription>Published {day(status.publishedAt)}</CardDescription>
        {/if}
      </CardHeader>
      <CardContent class="space-y-3 text-sm">
        {#if notes}
          <div
            class="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs"
            data-testid="release-notes"
          >{notes.text}</div>
        {/if}
        {#if status.releaseUrl}
          <a
            href={status.releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="text-sm font-medium underline underline-offset-4"
          >
            {notes?.truncated ? "Read the full release notes" : "Release notes"} on GitHub →
          </a>
        {/if}
      </CardContent>
    </Card>
  {/if}

  {#if status.upgradeAvailable}
    {#if !data.canUpgrade}
      <Alert data-testid="upgrade-ask-owner">
        <AlertTitle>Ask an Owner to install it</AlertTitle>
        <AlertDescription>
          Installing a Caelo update is done by an Owner of this site. Nothing changes for your work
          until then.
        </AlertDescription>
      </Alert>
    {:else if data.upgrade?.kind === "cli"}
      {@const upgrade = data.upgrade}
      <Card data-testid="upgrade-instructions">
        <CardHeader>
          <CardTitle class="text-base">Install v{status.latestVersion}</CardTitle>
          <CardDescription>
            Run this command in a terminal on the computer you installed Caelo from. It is made for
            this site ({upgrade.install}) and this release.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4 text-sm">
          <div class="flex items-start gap-2">
            <pre
              class="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted p-3 text-xs"
              data-testid="upgrade-command"><code>{upgrade.command}</code></pre>
            <Button
              variant="outline"
              size="sm"
              data-testid="copy-upgrade-command"
              aria-label="Copy upgrade command"
              onclick={() => copyCommand(upgrade.command)}
            >
              {#if copied}<Check class="size-4" />{:else}<Copy class="size-4" />{/if}
              Copy
            </Button>
          </div>

          <div class="space-y-1">
            <p class="font-medium">Before you run it</p>
            <ul class="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>
                Use the computer you installed from: the command needs its install folder
                (<code>~/.caelo-&lt;install id&gt;/</code>).
              </li>
              <li>
                Be signed in to Google Cloud there (<code>gcloud auth login</code>) with an account
                that may change this project.
              </li>
              <li>
                Have <a
                  href="https://docs.sigstore.dev/cosign/system_config/installation/"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="underline underline-offset-4">cosign</a
                > installed — the command uses it to check the release is genuine. On a Mac it offers
                to install it for you.
              </li>
              <li>
                Use a Google account that can open this admin: after switching, the command checks
                the new version by signing in through Google's access gate.
              </li>
            </ul>
          </div>

          <div class="space-y-1">
            <p class="font-medium">What it does</p>
            <ol class="list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>Checks that the new release was signed by Caelo's release process. It stops if not.</li>
              <li>
                Backs up your database and shows the backup's id. If the backup fails, it stops before
                anything has changed.
              </li>
              <li>
                Adds anything the new release needs in your Google Cloud project (permissions,
                stored keys). It stops here, before changing your site, if it can't.
              </li>
              <li>Updates your database to the new release's structure.</li>
              <li>
                Switches the admin and the public form service to the new release and checks that both
                work. If either check fails, both go back to the version you have now.
              </li>
            </ol>
            <p class="text-muted-foreground">
              If it had to go back, it prints the backup id and the exact command that restores it.
              Database changes stay in place, so you only need that command if the old version no longer
              works with them; restoring overwrites everything written since the backup.
            </p>
          </div>

          <p class="text-muted-foreground">
            It usually takes 5 to 15 minutes. Your public site stays online the whole time; the admin
            may be unavailable for a moment while it switches.
          </p>

          <a
            href={upgrade.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="inline-block font-medium underline underline-offset-4"
          >
            Upgrade guide in the documentation →
          </a>
        </CardContent>
      </Card>
    {:else if data.upgrade?.kind === "unsupported"}
      <Alert data-testid="upgrade-unsupported">
        <AlertTitle>No upgrade command for {data.upgrade.providerLabel} installs yet</AlertTitle>
        <AlertDescription>
          Caelo's upgrade command works for Google Cloud installs so far; support for this kind of
          install is being built. The
          <a
            href={data.upgrade.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="underline underline-offset-4">install guide</a
          > says what is possible today.
        </AlertDescription>
      </Alert>
    {:else if data.upgrade?.kind === "misconfigured"}
      <Alert variant="destructive" data-testid="upgrade-misconfigured">
        <AlertTitle>The upgrade command can't be built</AlertTitle>
        <AlertDescription>{data.upgrade.problem}</AlertDescription>
      </Alert>
    {/if}
  {/if}
</div>
