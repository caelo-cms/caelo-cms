<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * #696 — Settings → Updates. Versions + release notes for everyone with
   * settings.read; for the Owner (platform.update) on installs with the
   * upgrader job — or, self-hosted, a running update agent on the server —
   * "Install update": a confirmation of what will happen with the Owner's
   * password (#757), then a live timeline. Otherwise — and always as the
   * alternative — the pinned upgrade command for those who may run it.
   * See +page.server.ts, #lib/upgrade-path.ts and #lib/components/updates/.
   */

  import { Check, Copy, RefreshCw } from "lucide-svelte";
  import { enhance } from "$app/forms";
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
  import AgentSetup from "#lib/components/updates/AgentSetup.svelte";
  import AutoUpdatePolicy from "#lib/components/updates/AutoUpdatePolicy.svelte";
  import CloudShellUpgrade from "#lib/components/updates/CloudShellUpgrade.svelte";
  import PasswordConfirmDialog from "#lib/components/updates/PasswordConfirmDialog.svelte";
  import UpdateTimeline from "#lib/components/updates/UpdateTimeline.svelte";
  import { isActive, releaseCheckState, statusDisplay } from "#lib/updates-display.js";
  import { releaseNotesExcerpt } from "#lib/upgrade-path.js";
  import { cn } from "#lib/utils.js";

  let { data, form } = $props();

  const latestRequest = $derived(data.latest.request);
  const busy = $derived(latestRequest !== null && isActive(latestRequest.status));
  /** The Owner can install from here: permission + an upgrader job on this install. */
  const inProduct = $derived(data.canInstall && data.upgrader.available);
  let confirmOpen = $state(false);
  let cancelOpen = $state(false);
  /** #819 — "Continue" for a converge whose run died. */
  let continueOpen = $state(false);
  /** A wrong or missing password: the dialog it was typed into opens again with the message. */
  const stepUpError = $derived(
    form && "stepUpRequired" in form && form.stepUpRequired && "action" in form
      ? { action: form.action as string, error: form.error as string }
      : null,
  );
  $effect(() => {
    if (stepUpError?.action === "install") confirmOpen = true;
    if (stepUpError?.action === "cancel") cancelOpen = true;
    if (stepUpError?.action === "continueUpdate") continueOpen = true;
  });

  const status = $derived(data.status);

  /** Ticks every 30 s so "checked 40 min ago" stays true on an open tab. */
  let now = $state(new Date());
  $effect(() => {
    const id = setInterval(() => (now = new Date()), 30_000);
    return () => clearInterval(id);
  });
  // Re-read the clock whenever the page's data changes (after "Check now").
  $effect(() => {
    void status.checkedAt;
    now = new Date();
  });
  const checkState = $derived(releaseCheckState(status, now));

  /** "Check now" runs a GitHub request; the button says so while it does. */
  let checking = $state(false);
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
        {#if checkState.kind === "update_available"}
          <Badge variant="warning">Update available</Badge>
        {:else if checkState.kind === "up_to_date"}
          <Badge variant="success">Up to date</Badge>
        {:else if checkState.kind === "failed"}
          <Badge variant="destructive">Last check failed</Badge>
        {:else}
          <Badge variant="secondary">Not checked yet</Badge>
        {/if}
        {#if checkState.kind !== "never"}
          <span
            class="text-muted-foreground"
            data-testid="release-checked-at"
            title={status.checkedAt ? new Date(status.checkedAt).toLocaleString() : undefined}
          >· checked {checkState.ago}</span>
        {/if}
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <p class="text-muted-foreground" data-testid="release-check-explainer">
          {#if checkState.kind === "never"}
            Caelo checks for new releases once an hour and hasn't checked yet.
          {:else if checkState.kind === "failed"}
            The last check for new releases couldn't reach GitHub, so Caelo can't tell whether
            you're up to date. It tries again every hour.
          {:else}
            Caelo checks GitHub for new releases once an hour.
          {/if}
        </p>
        <form method="post" action="?/checkNow" use:enhance={() => {
            checking = true;
            return async ({ update }) => {
              await update();
              checking = false;
            };
          }}
        >
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={checking}
            data-testid="check-releases-now"
          >
            <RefreshCw class={cn("size-4", checking && "animate-spin")} />
            {checking ? "Checking…" : "Check now"}
          </Button>
        </form>
      </div>
      {#if form?.releaseCheck && form?.error}
        <p class="text-destructive" data-testid="release-check-error">{form.error}</p>
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
              >{#if data.deadRun.continuable && data.convergeJob}. Continue the update: Caelo
                picks up where it stopped, with the backup it took before it started.{:else}, and
                run the upgrade once with Cloud Shell if anything misbehaves.{/if}
            </AlertDescription>
          </Alert>
          {#if data.deadRun.continuable && data.convergeJob}
            <form id="continue-update-form" method="post" action="?/continueUpdate">
              <input type="hidden" name="_csrf" value={data.csrfToken} />
              <input type="hidden" name="requestId" value={latestRequest.id} />
            </form>
            <Button
              type="button"
              size="sm"
              data-testid="continue-update"
              onclick={() => (continueOpen = true)}
            >
              Continue the update…
            </Button>
            <PasswordConfirmDialog
              bind:open={continueOpen}
              formId="continue-update-form"
              title={`Continue the update to v${latestRequest.targetVersion}?`}
              description="Caelo starts its installer again. It keeps the backup it took before the update began, finishes what is left, tests the new version and goes back automatically if the test fails."
              submitLabel="Continue the update"
              error={stepUpError?.action === "continueUpdate" ? stepUpError.error : null}
              testid="continue-dialog"
            />
          {/if}
        {/if}
        {#key latestRequest.id}
          <UpdateTimeline
            request={latestRequest}
            events={data.latest.events}
            selfHosted={data.selfHosted}
          />
        {/key}
        {#if latestRequest.status === "pending" && data.canInstall}
          <form id="cancel-update-form" method="post" action="?/cancel">
            <input type="hidden" name="_csrf" value={data.csrfToken} />
            <input type="hidden" name="requestId" value={latestRequest.id} />
          </form>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="cancel-update"
            onclick={() => (cancelOpen = true)}
          >
            Cancel this update…
          </Button>
          <PasswordConfirmDialog
            bind:open={cancelOpen}
            formId="cancel-update-form"
            title={`Cancel the update to v${latestRequest.targetVersion}?`}
            description="It has not started yet; nothing on your site changes."
            submitLabel="Cancel the update"
            error={stepUpError?.action === "cancel" ? stepUpError.error : null}
            testid="cancel-dialog"
          />
        {/if}
      </CardContent>
    </Card>
  {/if}

  {#if latestRequest?.status === "needs_cloud_shell" && data.serverUpgrade}
    <Alert data-testid="server-upgrade">
      <AlertTitle>Install v{latestRequest.targetVersion} on the server once</AlertTitle>
      <AlertDescription>
        <p data-testid="server-upgrade-reason">{latestRequest.statusReason}</p>
        <p class="mt-1">
          Run the upgrade command on the server (below); afterwards updates install from here again.
        </p>
      </AlertDescription>
    </Alert>
    <!-- The same command further down (the newest release) is not repeated. -->
    {#if data.upgrade?.kind !== "cli" || data.upgrade.command !== data.serverUpgrade.command}
      {@render cliInstructions(data.serverUpgrade, latestRequest.targetVersion)}
    {/if}
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
    {:else if inProduct}
      <Card data-testid="install-update">
        <CardHeader>
          <CardTitle class="text-base">Install v{status.latestVersion}</CardTitle>
          <CardDescription>
            {#if data.selfHosted}
              The update agent on your server{data.agent?.status ? ` (${data.agent.status.host})` : ""}
              installs it: it checks the release is genuine, backs up your database, switches to the
              new version, tests it, and goes back automatically if the test fails. You confirm with
              your Caelo password.
            {:else}
              Caelo installs it from inside your Google Cloud project: it checks the release is
              genuine, backs up your database, switches to the new version, tests it, and goes back
              automatically if the test fails. You confirm with your Caelo password.
            {/if}
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-3 text-sm">
          {#if busy}
            <p class="text-muted-foreground">An update is already in progress (see above).</p>
          {:else}
            <Button data-testid="open-install-dialog" onclick={() => (confirmOpen = true)}>
              Install v{status.latestVersion}…
            </Button>
          {/if}
          {#if form?.error && !form?.policy && !form?.releaseCheck && !stepUpError}
            <p class="text-sm text-destructive" data-testid="install-error">{form.error}</p>
          {/if}
        </CardContent>
      </Card>
      {#if data.upgrade?.kind === "cli"}
        <details class="rounded-md border p-3 text-sm" data-testid="cli-alternative">
          <summary class="cursor-pointer font-medium">Install from a terminal instead</summary>
          <div class="mt-3">{@render cliInstructions(data.upgrade, status.latestVersion)}</div>
        </details>
      {/if}
    {:else if data.upgrade?.kind === "cli"}
      {#if data.canInstall && data.upgrader.problem}
        <Alert variant="destructive" data-testid="upgrader-problem">
          <AlertTitle>The admin cannot start the upgrader</AlertTitle>
          <AlertDescription>{data.upgrader.problem}</AlertDescription>
        </Alert>
      {/if}
      {#if data.agent && !data.upgrader.available && !busy}
        <AgentSetup
          agent={data.agent.status}
          problem={data.agent.problem}
          installCommand={data.agent.installCommand}
        />
      {/if}
      {@render cliInstructions(data.upgrade, status.latestVersion)}
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

  <AutoUpdatePolicy
    policy={data.policy}
    scheduler={data.scheduler}
    canEdit={data.canInstall}
    csrfToken={data.csrfToken}
    error={form?.policy ? (form.error ?? null) : null}
    failedAction={stepUpError?.action ?? null}
    upgraderAvailable={data.upgrader.available}
  />

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
              <Badge variant={statusDisplay(r.status, data.selfHosted).tone}>
                {statusDisplay(r.status, data.selfHosted).label}
              </Badge>
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

{#if inProduct && status.latestVersion}
  <form id="install-form" method="post" action="?/install">
    <input type="hidden" name="_csrf" value={data.csrfToken} />
    <input type="hidden" name="version" value={status.latestVersion} />
  </form>
  <PasswordConfirmDialog
    bind:open={confirmOpen}
    formId="install-form"
    title={`Install Caelo v${status.latestVersion}?`}
    description="What happens, in order:"
    submitLabel={`Install v${status.latestVersion}`}
    error={stepUpError?.action === "install" ? stepUpError.error : null}
    testid="install-dialog"
  >
    <ol class="list-decimal space-y-1 pl-5 text-sm">
      <li>The release's signature is checked; an unsigned or older release is refused.</li>
      <li>Your database is backed up. If that fails, nothing changes.</li>
      <li>The database is updated to the new version's structure.</li>
      <li>The admin and the public form service switch to v{status.latestVersion} and are tested.</li>
      <li>If a test fails, both go back to v{status.installedVersion} automatically.</li>
    </ol>
    <p class="text-sm text-muted-foreground">
      {#if data.selfHosted}
        The update agent picks it up within a minute; the update takes about 5 to 15 minutes. Your
        public site stays online. The admin restarts once and may be unreachable for about a
        minute; unsaved typing elsewhere in the admin can be lost.
      {:else}
        Takes about 5 to 15 minutes. Your public site stays online. The admin restarts once and may be
        unreachable for about a minute; unsaved typing elsewhere in the admin can be lost.
        {#if data.convergeJob}
          If this release also changes settings in your Google Cloud project, Caelo makes those
          changes too, as part of the same update.
        {:else}
          If this release needs a change to your cloud setup, nothing is installed and this page
          explains the Cloud Shell step instead.
        {/if}
      {/if}
    </p>
  </PasswordConfirmDialog>
{/if}

{#snippet cliInstructions(
  upgrade: { provider: string; command: string; install: string; docsUrl: string },
  version: string | null,
)}
    <Card data-testid="upgrade-instructions">
      <CardHeader>
        <CardTitle class="text-base">Install v{version}</CardTitle>
        <CardDescription>
          {#if upgrade.provider === "self-hosted"}
            Run this command on the server that runs this site, in the folder that holds
            <code>.caelo/</code>. It is made for this release.
          {:else}
            Run this command in a terminal on the computer you installed Caelo from. It is made for
            this site ({upgrade.install}) and this release.
          {/if}
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

        {#if upgrade.provider === "self-hosted"}
          <div class="space-y-1">
            <p class="font-medium">Before you run it</p>
            <ul class="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>Run it as the user that runs your Caelo install (a member of the docker group).</li>
              <li>
                Have <a
                  href="https://docs.sigstore.dev/cosign/system_config/installation/"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="underline underline-offset-4">cosign</a
                > installed on the server — the command uses it to check the release is genuine.
              </li>
            </ul>
          </div>
          <div class="space-y-1">
            <p class="font-medium">What it does</p>
            <ol class="list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>Checks that the new release was signed by Caelo's release process. It stops if not.</li>
              <li>
                Backs up both databases into <code>.caelo/backups/</code>. If the backup fails, it
                stops before anything has changed.
              </li>
              <li>Updates your database to the new release's structure.</li>
              <li>
                Switches the admin and the public form service to the new release and checks that
                both work. If either check fails, both go back to the version you have now.
              </li>
              <li>Sets up (or updates) the update agent, so the next update installs from here.</li>
            </ol>
          </div>
        {:else}
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
        {/if}

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
