<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * #696 — Settings → Updates. Versions + release notes for everyone with
   * settings.read; for the Owner (platform.update) on installs with the
   * upgrader job, "Install update": a fresh Google sign-in, a confirmation of
   * what will happen, then a live timeline. Otherwise — and always as the
   * alternative — the pinned upgrade command for those who may run it.
   * See +page.server.ts, #lib/upgrade-path.ts and #lib/components/updates/.
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
  import CloudShellUpgrade from "#lib/components/updates/CloudShellUpgrade.svelte";
  import StepUpSetup from "#lib/components/updates/StepUpSetup.svelte";
  import UpdateTimeline from "#lib/components/updates/UpdateTimeline.svelte";
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from "#lib/components/ui/dialog/index.js";
  import { isActive, STATUS_DISPLAY } from "#lib/updates-display.js";
  import { releaseNotesExcerpt } from "#lib/upgrade-path.js";

  let { data, form } = $props();

  const latestRequest = $derived(data.latest.request);
  const busy = $derived(latestRequest !== null && isActive(latestRequest.status));
  /** The Owner can install from here: permission + an upgrader job on this install. */
  const inProduct = $derived(data.canInstall && data.upgrader.available);
  let confirmOpen = $state(false);

  // Back from Google: open the confirmation the sign-in was for.
  $effect(() => {
    const r = data.stepUpResult;
    if (r?.ok && r.purpose === "platform_update" && data.stepUp?.fresh && !busy) confirmOpen = true;
    if (r && !r.ok) toast.error(`Google sign-in: ${r.message}`);
  });

  function until(iso: string | null): string {
    return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  }

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

  {#if latestRequest}
    <Card data-testid="latest-update">
      <CardHeader>
        <CardTitle class="text-base">{busy ? "Update in progress" : "Latest update"}</CardTitle>
        {#if busy}
          <CardDescription>
            You can leave this page; the update keeps going. The admin restarts once while it
            switches — this page reconnects by itself.
          </CardDescription>
        {/if}
      </CardHeader>
      <CardContent class="space-y-3">
        {#if data.deadRun}
          <Alert variant="destructive" data-testid="upgrader-stopped">
            <AlertTitle>The upgrader stopped before it finished</AlertTitle>
            <AlertDescription>
              Its run ended without reporting back. Your site may still run the previous version, or
              the new one may be partly switched. Open the site to check, see
              <a
                href={data.deadRun.logsUrl}
                target="_blank"
                rel="noopener noreferrer"
                class="underline underline-offset-4">the upgrader's log</a
              >, and run the upgrade once with Cloud Shell if anything misbehaves.
            </AlertDescription>
          </Alert>
        {/if}
        {#key latestRequest.id}
          <UpdateTimeline request={latestRequest} events={data.latest.events} />
        {/key}
        {#if latestRequest.status === "pending" && data.canInstall}
          <form method="post" action={data.stepUp?.fresh ? "?/cancel" : "?/stepUp"}>
            <input type="hidden" name="_csrf" value={data.csrfToken} />
            <input type="hidden" name="requestId" value={latestRequest.id} />
            <input type="hidden" name="purpose" value="platform_update" />
            <Button type="submit" variant="outline" size="sm" data-testid="cancel-update">
              {data.stepUp?.fresh ? "Cancel this update" : "Cancel (confirm with Google first)"}
            </Button>
          </form>
        {/if}
      </CardContent>
    </Card>
  {/if}

  {#if latestRequest?.status === "needs_cloud_shell" && data.cloudShell}
    <CloudShellUpgrade
      version={latestRequest.targetVersion}
      reason={latestRequest.statusReason}
      consoleUrl={data.cloudShell.consoleUrl}
      commands={data.cloudShell.commands}
    />
  {/if}

  {#if status.upgradeAvailable}
    {#if !data.canUpgrade && !data.canInstall}
      <Alert data-testid="upgrade-ask-owner">
        <AlertTitle>Ask an Owner to install it</AlertTitle>
        <AlertDescription>
          Installing a Caelo update is done by an Owner of this site. Nothing changes for your work
          until then.
        </AlertDescription>
      </Alert>
    {:else if inProduct && data.stepUp && !data.stepUp.configured}
      <StepUpSetup
        csrfToken={data.csrfToken}
        redirectUri={data.redirectUri}
        credentialsUrl={data.credentialsUrl}
      />
      {#if data.upgrade?.kind === "cli"}
        <details class="rounded-md border p-3 text-sm" data-testid="cli-alternative">
          <summary class="cursor-pointer font-medium">Install from a terminal instead</summary>
          <div class="mt-3">{@render cliInstructions(data.upgrade)}</div>
        </details>
      {/if}
    {:else if inProduct && data.stepUp}
      <Card data-testid="install-update">
        <CardHeader>
          <CardTitle class="text-base">Install v{status.latestVersion}</CardTitle>
          <CardDescription>
            Caelo installs it from inside your Google Cloud project: it checks the release is
            genuine, backs up your database, switches to the new version, tests it, and goes back
            automatically if the test fails. You confirm with a fresh Google sign-in.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-3 text-sm">
          {#if busy}
            <p class="text-muted-foreground">An update is already in progress (see above).</p>
          {:else if data.stepUp.fresh}
            <p class="text-muted-foreground" data-testid="step-up-fresh">
              Confirmed with Google — valid until {until(data.stepUp.freshUntil)}.
            </p>
            <Button data-testid="open-install-dialog" onclick={() => (confirmOpen = true)}>
              Install v{status.latestVersion}…
            </Button>
          {:else}
            <form method="post" action="?/stepUp">
              <input type="hidden" name="_csrf" value={data.csrfToken} />
              <input type="hidden" name="purpose" value="platform_update" />
              <Button type="submit" data-testid="step-up-install">
                Confirm with Google to install v{status.latestVersion}
              </Button>
            </form>
            <p class="text-xs text-muted-foreground">
              Google asks for your password again (and your second factor, if you use one) — even if
              you are signed in to Google already.
            </p>
          {/if}
          {#if form?.error}
            <p class="text-sm text-destructive" data-testid="install-error">{form.error}</p>
          {/if}
        </CardContent>
      </Card>
      {#if data.upgrade?.kind === "cli"}
        <details class="rounded-md border p-3 text-sm" data-testid="cli-alternative">
          <summary class="cursor-pointer font-medium">Install from a terminal instead</summary>
          <div class="mt-3">{@render cliInstructions(data.upgrade)}</div>
        </details>
      {/if}
    {:else if data.upgrade?.kind === "cli"}
      {#if data.canInstall && data.upgrader.problem}
        <Alert variant="destructive" data-testid="upgrader-problem">
          <AlertTitle>The admin cannot start the upgrader</AlertTitle>
          <AlertDescription>{data.upgrader.problem}</AlertDescription>
        </Alert>
      {/if}
      {@render cliInstructions(data.upgrade)}
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

  {#if data.history.length > 0}
    <Card>
      <CardHeader>
        <CardTitle class="text-base">Update history</CardTitle>
      </CardHeader>
      <CardContent>
        <ul class="divide-y text-sm" data-testid="update-history">
          {#each data.history as r (r.id)}
            <li class="flex flex-wrap items-center gap-2 py-2">
              <span class="font-mono text-xs text-muted-foreground">{day(r.requestedAt)}</span>
              <span>v{r.fromVersion} → v{r.targetVersion}</span>
              <Badge variant={STATUS_DISPLAY[r.status].tone}>{STATUS_DISPLAY[r.status].label}</Badge>
              <span class="text-xs text-muted-foreground">
                {r.trigger === "auto" ? "automatic" : (r.requestedBy ?? "")}
              </span>
            </li>
          {/each}
        </ul>
      </CardContent>
    </Card>
  {/if}
</div>

{#if inProduct && data.stepUp?.fresh && status.latestVersion}
  <Dialog bind:open={confirmOpen}>
    <DialogContent data-testid="install-dialog">
      <DialogHeader>
        <DialogTitle>Install Caelo v{status.latestVersion}?</DialogTitle>
        <DialogDescription>What happens, in order:</DialogDescription>
      </DialogHeader>
      <ol class="list-decimal space-y-1 pl-5 text-sm">
        <li>The release's signature is checked; an unsigned or older release is refused.</li>
        <li>Your database is backed up. If that fails, nothing changes.</li>
        <li>The database is updated to the new version's structure.</li>
        <li>The admin and the public form service switch to v{status.latestVersion} and are tested.</li>
        <li>If a test fails, both go back to v{status.installedVersion} automatically.</li>
      </ol>
      <p class="text-sm text-muted-foreground">
        Takes about 5 to 15 minutes. Your public site stays online. The admin restarts once and may be
        unreachable for about a minute; unsaved typing elsewhere in the admin can be lost. If this
        release needs a change to your cloud setup, nothing is installed and this page explains the
        Cloud Shell step instead.
      </p>
      <form method="post" action="?/install">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <input type="hidden" name="version" value={status.latestVersion} />
        <DialogFooter>
          <Button type="button" variant="ghost" onclick={() => (confirmOpen = false)}>
            Not now
          </Button>
          <Button type="submit" data-testid="confirm-install">Install v{status.latestVersion}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
{/if}

{#snippet cliInstructions(upgrade: { command: string; install: string; docsUrl: string })}
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
{/snippet}
