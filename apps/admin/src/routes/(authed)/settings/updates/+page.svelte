<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * #696, #861 — Settings → Updates answers one question: can I update, and
   * how? The page derives ONE state from what it loaded (`updatePageState`
   * in #lib/updates-display.ts — first match of nine, in priority order) and
   * shows it at the top in a status card: the versions, one sentence and
   * exactly one primary action (Install, Try again, Cloud Shell, the
   * terminal command, Check now, or nothing). A running update replaces the
   * card's body with its live timeline. Everything else is reference, below
   * it and collapsed with a one-line summary: the release notes, Automatic
   * updates, History, Other ways to install. Cloud Shell is break-glass: in
   * the status card only in the `break_glass` state, never next to an
   * Install button for the same release.
   * See +page.server.ts, #lib/upgrade-path.ts and #lib/components/updates/.
   */

  import { Check, ChevronDown, Copy } from "lucide-svelte";
  import { applyAction, enhance, type SubmitFunction } from "$app/forms";
  import { toast } from "svelte-sonner";
  import { Alert, AlertDescription, AlertTitle } from "#lib/components/ui/alert/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { buttonVariants } from "#lib/components/ui/button/button-variants.js";
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
  import { thrownErrorAsFailure } from "#lib/thrown-error-message.js";
  import {
    autoUpdateModeLine,
    checkedAgo,
    historySummary,
    isActive,
    statusDisplay,
    updatePageState,
  } from "#lib/updates-display.js";
  import { hasOwnerNotes, ownerReleaseNotes } from "#lib/owner-release-notes.js";

  let { data, form } = $props();

  const latestRequest = $derived(data.latest.request);
  let confirmOpen = $state(false);
  let cancelOpen = $state(false);
  /** #819 — "Continue" for a converge whose run died. */
  let continueOpen = $state(false);
  /** #868 — "Skip this time" for a scheduled automatic install. */
  let skipOpen = $state(false);
  /**
   * A wrong or missing password, or an error the server threw (a form
   * token that no longer verifies): the dialog it came from opens again
   * with the message.
   */
  const stepUpError = $derived(
    form &&
      "action" in form &&
      (("stepUpRequired" in form && form.stepUpRequired) ||
        ("thrownError" in form && form.thrownError))
      ? { action: form.action as string, error: form.error as string }
      : null,
  );
  $effect(() => {
    if (stepUpError?.action === "install") confirmOpen = true;
    if (stepUpError?.action === "cancel") cancelOpen = true;
    if (stepUpError?.action === "continueUpdate") continueOpen = true;
    if (stepUpError?.action === "skipScheduled") skipOpen = true;
  });

  type DialogAction = "install" | "cancel" | "continueUpdate" | "skipScheduled";
  function closeDialog(action: DialogAction): void {
    if (action === "install") confirmOpen = false;
    else if (action === "cancel") cancelOpen = false;
    else if (action === "continueUpdate") continueOpen = false;
    else skipOpen = false;
  }

  /**
   * Submits a password dialog's form in place, so what goes wrong shows in
   * that dialog instead of SvelteKit's error page: a wrong password comes
   * back as a failure that keeps the dialog open, and an error the server
   * throws (a CSRF token that no longer verifies) is shown the same way.
   * Success and any other failure close the dialog: the result shows on the
   * page, under the status card.
   */
  function submitInDialog(action: DialogAction): SubmitFunction {
    return () =>
      async ({ result, update }) => {
        if (result.type === "error") {
          await applyAction(thrownErrorAsFailure(result, action));
          return;
        }
        await update();
        if (
          result.type === "success" ||
          (result.type === "failure" && result.data?.stepUpRequired !== true)
        ) {
          closeDialog(action);
        }
      };
  }

  const status = $derived(data.status);

  /**
   * Ticks every 30 s so "checked 40 min ago" stays true on an open tab
   * (and an ended pause stops holding back a scheduled install).
   */
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

  /** The page's one state: sentence, badge and the single primary action. */
  const pageState = $derived(
    updatePageState({
      canInstall: data.canInstall,
      canUpgrade: data.canUpgrade,
      status,
      request: latestRequest,
      events: data.latest.events,
      deadRunLogsUrl: data.deadRun?.logsUrl ?? null,
      deadRunContinuable: data.deadRun?.continuable ?? false,
      scheduler: data.scheduler,
      policy: data.policy,
      now,
      installRoute: data.installRoute,
      selfHosted: data.selfHosted,
      convergeJob: data.convergeJob,
      breakGlassAvailable: data.breakGlassAvailable,
    }),
  );
  const action = $derived(pageState.action);
  /**
   * The release the heading points at: while an update runs (or waits),
   * the one it installs — a newer release found meanwhile must not make the
   * card say "→ vNewest" over a timeline installing another version.
   */
  const headingTarget = $derived(
    latestRequest !== null && isActive(latestRequest.status)
      ? latestRequest.targetVersion
      : status.upgradeAvailable
        ? status.latestVersion
        : null,
  );
  /** The release the Install dialog installs (only while Install is the action). */
  const installVersion = $derived(action.kind === "install" ? action.version : null);
  /** The last attempt's timeline belongs in the status card (it explains the state). */
  const attemptInCard = $derived(
    latestRequest !== null &&
      (pageState.kind === "interrupted" ||
        pageState.kind === "rolled_back" ||
        (pageState.kind === "break_glass" &&
          latestRequest.status === "needs_cloud_shell" &&
          latestRequest.targetVersion === status.latestVersion)),
  );

  const checkedAt = $derived(status.checkedAt ? checkedAgo(status.checkedAt, now) : null);

  /** "Check now" runs a GitHub request; the control says so while it does. */
  let checking = $state(false);
  /** The release notes in Owner words (#862): no hashes, issue numbers or "BREAKING". */
  const notes = $derived(
    status.releaseNotes
      ? ownerReleaseNotes(status.releaseNotes, { breakingAction: status.ownerAction })
      : null,
  );
  const noteGroups = $derived(
    notes
      ? [
          { title: "New", items: notes.added },
          { title: "Fixed", items: notes.fixed },
          { title: "Security", items: notes.security },
        ].filter((g) => g.items.length > 0)
      : [],
  );
  let copied = $state(false);

  /** Other ways to install the newest release, minus the one the status card already shows. */
  const otherTerminal = $derived(
    status.upgradeAvailable &&
      data.upgrade?.kind === "cli" &&
      action.kind !== "terminal" &&
      action.kind !== "server_command",
  );
  const otherCloudShell = $derived(data.cloudShell !== null && action.kind !== "cloud_shell");

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

  const checkNowEnhance = () => {
    checking = true;
    return async ({ update }: { update: () => Promise<void> }) => {
      await update();
      checking = false;
    };
  };
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Caelo updates</h1>
    <p class="text-sm text-muted-foreground">
      Which version of Caelo your site runs, and whether you can update it.
    </p>
  </div>

  <form id="check-now-form" method="post" action="?/checkNow" use:enhance={checkNowEnhance}>
    <input type="hidden" name="_csrf" value={data.csrfToken} />
  </form>

  <Card data-testid="update-status-card" data-state={pageState.kind}>
    <CardHeader class="space-y-2">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <CardTitle class="flex flex-wrap items-baseline gap-2 font-mono text-lg">
          <span data-testid="installed-version">v{status.installedVersion}</span>
          {#if headingTarget}
            <span class="text-muted-foreground" aria-hidden="true">→</span>
            <span data-testid="target-version">v{headingTarget}</span>
          {/if}
        </CardTitle>
        {#if pageState.kind !== "in_progress"}
          <Badge variant={pageState.badge.tone} data-testid="update-state-badge">
            {pageState.badge.label}
          </Badge>
        {/if}
      </div>
      <p class="text-xs text-muted-foreground">
        {#if checkedAt}
          <span
            data-testid="release-checked-at"
            title={status.checkedAt ? new Date(status.checkedAt).toLocaleString() : undefined}
          >checked {checkedAt}</span>
        {:else}
          <span>not checked yet</span>
        {/if}
        {#if action.kind !== "check_now"}
          ·
          <button
            type="submit"
            form="check-now-form"
            class="underline underline-offset-4 hover:text-foreground disabled:opacity-50"
            disabled={checking}
            data-testid="check-releases-now"
          >{checking ? "Checking…" : "Check now"}</button>
        {/if}
      </p>
    </CardHeader>
    <CardContent class="space-y-4 text-sm">
      {#if pageState.kind === "in_progress" && latestRequest}
        {#key latestRequest.id}
          <UpdateTimeline
            request={latestRequest}
            events={data.latest.events}
            selfHosted={data.selfHosted}
            showProgress
          />
        {/key}
        {#if action.kind === "timeline" && action.cancellable && latestRequest.status === "pending"}
          <form id="cancel-update-form" method="post" action="?/cancel" use:enhance={submitInDialog("cancel")}>
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
      {:else}
        <p class="text-base" data-testid="update-state-sentence">{pageState.sentence}</p>
        {#if pageState.detail}
          <p class="text-muted-foreground" data-testid="update-state-detail">{pageState.detail}</p>
        {/if}

        {#if action.kind === "install"}
          <div class="flex flex-wrap items-center gap-3" data-testid="install-update">
            <Button data-testid="open-install-dialog" onclick={() => (confirmOpen = true)}>
              {action.label}
            </Button>
            {#if pageState.secondary?.kind === "skip"}
              <Button
                type="button"
                variant="outline"
                data-testid="open-skip-dialog"
                onclick={() => (skipOpen = true)}
              >
                Skip this time…
              </Button>
            {/if}
            <span class="text-xs text-muted-foreground">
              You confirm with your password · about 5 to 15 minutes
              {#if data.selfHosted}· installed by the update agent on your server{data.agent?.status
                  ? ` (${data.agent.status.host})`
                  : ""}{/if}
            </span>
          </div>
          {#if pageState.secondary?.kind === "skip"}
            <form
              id="skip-scheduled-form"
              method="post"
              action="?/skipScheduled"
              use:enhance={submitInDialog("skipScheduled")}
            >
              <input type="hidden" name="_csrf" value={data.csrfToken} />
              <input type="hidden" name="version" value={pageState.secondary.version} />
            </form>
            <PasswordConfirmDialog
              bind:open={skipOpen}
              formId="skip-scheduled-form"
              title={`Skip the automatic install of v${pageState.secondary.version}?`}
              description="Caelo won't install this version by itself. It stays available here, so you can install it whenever you're ready, and the next newer version installs automatically again."
              submitLabel="Skip this version"
              error={stepUpError?.action === "skipScheduled" ? stepUpError.error : null}
              testid="skip-dialog"
            />
          {/if}
        {:else if action.kind === "terminal" || action.kind === "server_command"}
          {#if data.upgrade?.kind === "cli"}
            {@render cliInstructions(data.upgrade, action.version)}
          {/if}
        {:else if action.kind === "cloud_shell" && data.cloudShell}
          <CloudShellUpgrade
            version={action.version}
            consoleUrl={data.cloudShell.consoleUrl}
            command={data.cloudShell.command}
            prominent
          />
        {:else if action.kind === "continue" && latestRequest}
          <form
            id="continue-update-form"
            method="post"
            action="?/continueUpdate"
            use:enhance={submitInDialog("continueUpdate")}
          >
            <input type="hidden" name="_csrf" value={data.csrfToken} />
            <input type="hidden" name="requestId" value={latestRequest.id} />
          </form>
          <div class="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              data-testid="continue-update"
              onclick={() => (continueOpen = true)}
            >
              Continue the update…
            </Button>
            <a
              href={action.logsUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="text-sm underline underline-offset-4"
              data-testid="upgrader-log"
            >
              The installer's log
            </a>
          </div>
          <PasswordConfirmDialog
            bind:open={continueOpen}
            formId="continue-update-form"
            title={`Continue the update to v${action.version}?`}
            description="Caelo starts its installer again. It keeps the backup it took before the update began, finishes what is left, tests the new version and goes back automatically if the test fails."
            submitLabel="Continue the update"
            error={stepUpError?.action === "continueUpdate" ? stepUpError.error : null}
            testid="continue-dialog"
          />
        {:else if action.kind === "logs"}
          <a
            href={action.url}
            target="_blank"
            rel="noopener noreferrer"
            class={buttonVariants({ variant: "default" })}
            data-testid="upgrader-log"
          >
            Open the upgrader's log
          </a>
        {:else if action.kind === "check_now"}
          <Button
            type="submit"
            form="check-now-form"
            disabled={checking}
            data-testid="check-releases-now"
          >
            {checking ? "Checking…" : "Check now"}
          </Button>
        {:else if pageState.kind === "update_available"}
          {#if data.upgrade?.kind === "unsupported"}
            <Alert data-testid="upgrade-unsupported">
              <AlertTitle>No upgrade command for {data.upgrade.providerLabel} installs yet</AlertTitle>
              <AlertDescription>
                Caelo's upgrade command works for Google Cloud and self-hosted installs so far. The
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

        {#if data.canInstall && data.upgrader.problem && (action.kind === "terminal" || action.kind === "none") && status.upgradeAvailable}
          <Alert variant="destructive" data-testid="upgrader-problem">
            <AlertTitle>The admin cannot start the upgrader</AlertTitle>
            <AlertDescription>{data.upgrader.problem}</AlertDescription>
          </Alert>
        {/if}
        {#if form?.error && !form?.policy && !form?.releaseCheck && !stepUpError}
          <p class="text-destructive" data-testid="install-error">{form.error}</p>
        {/if}
        {#if attemptInCard && latestRequest}
          <details class="group rounded-md border p-3" data-testid="last-attempt">
            <summary class="flex cursor-pointer list-none items-center justify-between font-medium">
              What happened
              <ChevronDown class="size-4 transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <div class="mt-3">
              {#key latestRequest.id}
                <UpdateTimeline
                  request={latestRequest}
                  events={data.latest.events}
                  selfHosted={data.selfHosted}
                />
              {/key}
            </div>
          </details>
        {/if}
      {/if}
      {#if form?.releaseCheck && form?.error}
        <p class="text-destructive" data-testid="release-check-error">{form.error}</p>
      {/if}
    </CardContent>
  </Card>

  {#if data.agent?.installCommand && !data.upgrader.available && status.upgradeAvailable && pageState.kind === "update_available"}
    <AgentSetup
      agent={data.agent.status}
      problem={data.agent.problem}
      installCommand={data.agent.installCommand}
    />
  {/if}

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
        {#if notes && hasOwnerNotes(notes)}
          <div class="max-h-80 space-y-3 overflow-y-auto rounded-md bg-muted p-3" data-testid="release-notes">
            {#if notes.breaking}
              <p data-testid="release-notes-breaking">
                <span class="font-medium">Before you update:</span> {notes.breaking}
              </p>
            {/if}
            {#each noteGroups as group (group.title)}
              <div>
                <p class="font-medium">{group.title}</p>
                <ul class="list-disc space-y-0.5 pl-5">
                  {#each group.items as item, i (i)}
                    <li>{item}</li>
                  {/each}
                </ul>
              </div>
            {/each}
          </div>
        {/if}
        {#if status.releaseUrl}
          <a
            href={status.releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="text-sm font-medium underline underline-offset-4"
          >
            All changes on GitHub →
          </a>
        {/if}
      </CardContent>
    </Card>
  {/if}

  <div class="divide-y rounded-lg border">
    <details class="group" data-testid="section-auto-updates">
      <summary class="flex cursor-pointer list-none items-start justify-between gap-3 p-4">
        <span class="space-y-0.5">
          <span class="block font-medium">Automatic updates</span>
          <span class="block text-sm text-muted-foreground" data-testid="auto-update-line">
            {autoUpdateModeLine(data.policy)}
            {#if !data.emailConfigured}
              · Email not set up
            {/if}
          </span>
        </span>
        <ChevronDown class="mt-1 size-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div class="space-y-4 px-4 pb-4">
        <!-- Not in the <summary>: a link there is a control inside a control
             (axe nested-interactive). /settings/email needs settings.write. -->
        {#if !data.emailConfigured}
          <p class="text-sm text-muted-foreground" data-testid="email-not-set-up">
            Update emails need an email service, and none is set up.
            {#if data.canUpgrade}
              <a href="/settings/email" class="underline underline-offset-4" data-testid="setup-email"
                >Set up email</a
              >
            {:else}
              Ask an Owner of this site to set one up.
            {/if}
          </p>
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
      </div>
    </details>

    {#if data.history.length > 0}
      <details class="group" data-testid="section-history">
        <summary class="flex cursor-pointer list-none items-start justify-between gap-3 p-4">
          <span class="space-y-0.5">
            <span class="block font-medium">History</span>
            <span class="block text-sm text-muted-foreground" data-testid="history-line">
              {historySummary(data.history, data.latest.events, data.selfHosted)}
            </span>
          </span>
          <ChevronDown class="mt-1 size-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div class="space-y-4 px-4 pb-4">
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
          {#if latestRequest && pageState.kind !== "in_progress" && !attemptInCard}
            <div class="space-y-2">
              <p class="font-medium">The last attempt, step by step</p>
              {#key latestRequest.id}
                <UpdateTimeline
                  request={latestRequest}
                  events={data.latest.events}
                  selfHosted={data.selfHosted}
                />
              {/key}
            </div>
          {/if}
        </div>
      </details>
    {/if}

    {#if otherTerminal || otherCloudShell}
      <details class="group" data-testid="section-other-ways">
        <summary class="flex cursor-pointer list-none items-start justify-between gap-3 p-4">
          <span class="space-y-0.5">
            <span class="block font-medium">Other ways to install</span>
            <span class="block text-sm text-muted-foreground">
              {[
                otherTerminal ? (data.selfHosted ? "The upgrade command on your server" : "A terminal") : null,
                otherCloudShell ? "Google Cloud Shell, for emergencies" : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </span>
          <ChevronDown class="mt-1 size-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div class="space-y-6 px-4 pb-4">
          {#if otherTerminal && data.upgrade?.kind === "cli"}
            {@render cliInstructions(data.upgrade, status.latestVersion)}
          {/if}
          {#if otherCloudShell && data.cloudShell && status.latestVersion}
            <div class="space-y-2">
              <p class="font-medium">Google Cloud Shell</p>
              <p class="text-sm text-muted-foreground">
                Only if installing from here keeps failing: the same update, run once with your own
                Google account.
              </p>
              <CloudShellUpgrade
                version={status.latestVersion}
                consoleUrl={data.cloudShell.consoleUrl}
                command={data.cloudShell.command}
              />
            </div>
          {/if}
        </div>
      </details>
    {/if}
  </div>
</div>

{#if installVersion}
  <form id="install-form" method="post" action="?/install" use:enhance={submitInDialog("install")}>
    <input type="hidden" name="_csrf" value={data.csrfToken} />
    <input type="hidden" name="version" value={installVersion} />
  </form>
  <PasswordConfirmDialog
    bind:open={confirmOpen}
    formId="install-form"
    title={`Install Caelo v${installVersion}?`}
    description="What happens, in order:"
    submitLabel={`Install v${installVersion}`}
    error={stepUpError?.action === "install" ? stepUpError.error : null}
    testid="install-dialog"
  >
    <ol class="list-decimal space-y-1 pl-5 text-sm">
      <li>The release's signature is checked; an unsigned or older release is refused.</li>
      <li>Your database is backed up. If that fails, nothing changes.</li>
      <li>The database is updated to the new version's structure.</li>
      <li>The admin and the public form service switch to v{installVersion} and are tested.</li>
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
