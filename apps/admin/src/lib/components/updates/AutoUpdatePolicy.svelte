<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * #696 Phase 5 — Settings → Updates → Automatic updates. Shows the Owner's
   * policy in plain words, what the scheduler last decided and which update
   * emails went out; lets the Owner change the policy, pause or resume —
   * each confirmed with their password (decisions 4 + 6, #757). The ops
   * re-check the permission and the confirmation and use it up.
   */

  import type { SchedulerStatus } from "@caelo-cms/admin-core";
  import { applyAction, enhance, type SubmitFunction } from "$app/forms";
  import type { StoredUpdatePolicy } from "@caelo-cms/shared";
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
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Select } from "#lib/components/ui/select/index.js";
  import { cn } from "#lib/utils.js";
  import PasswordConfirmDialog from "./PasswordConfirmDialog.svelte";
  import {
    autoUpdateSummary,
    DELIVERY_DISPLAY,
    pauseSummary,
    SCHEDULER_ACTION_LABELS,
  } from "#lib/auto-update-display.js";
  import { thrownErrorAsFailure } from "#lib/thrown-error-message.js";

  let {
    policy,
    scheduler,
    canEdit,
    csrfToken,
    error,
    failedAction,
    upgraderAvailable,
  }: {
    policy: StoredUpdatePolicy;
    scheduler: SchedulerStatus;
    canEdit: boolean;
    csrfToken: string;
    error: string | null;
    /** The policy action whose password confirmation just failed; its dialog reopens. */
    failedAction: string | null;
    /** This install has an upgrader (Cloud Run job or the self-hosted agent). */
    upgraderAvailable: boolean;
  } = $props();

  /** Which change the password dialog confirms; null = closed. */
  type PolicyAction = "savePolicy" | "pause" | "resume";
  const FORM_IDS: Record<PolicyAction, string> = {
    savePolicy: "policy-form",
    pause: "pause-form",
    resume: "resume-form",
  };
  const TITLES: Record<PolicyAction, string> = {
    savePolicy: "Save the automatic-update settings?",
    pause: "Pause automatic updates?",
    resume: "Resume automatic updates?",
  };
  const isPolicyAction = (a: string | null): a is PolicyAction =>
    a === "savePolicy" || a === "pause" || a === "resume";
  // svelte-ignore state_referenced_locally
  let confirming = $state<PolicyAction | null>(isPolicyAction(failedAction) ? failedAction : null);
  $effect(() => {
    if (isPolicyAction(failedAction)) confirming = failedAction;
  });

  /**
   * Submitted in place, so a wrong password keeps what the Owner typed into
   * the form (a full reload would show the stored policy again); the dialog
   * closes once the change went through. An error the server throws (a CSRF
   * token that no longer verifies) shows in the dialog like a wrong password
   * instead of replacing the page with SvelteKit's error page.
   */
  const submitInPlace: SubmitFunction = () => async ({ result, update }) => {
    if (result.type === "error" && confirming) {
      await applyAction(thrownErrorAsFailure(result, confirming, { policy: true }));
      return;
    }
    await update({ reset: false });
    if (result.type === "success") confirming = null;
  };

  // svelte-ignore state_referenced_locally
  let mode = $state(policy.mode);
  // svelte-ignore state_referenced_locally
  let windowOn = $state(policy.windowStart !== null);
  // Bound so each kind shows its current waiting time next to it.
  // svelte-ignore state_referenced_locally
  let soakHours = $state<number | null>(policy.soakHours);
  // svelte-ignore state_referenced_locally
  let securitySoakHours = $state<number | null>(policy.securitySoakHours);

  /** "after 24 hours" for a kind's checkbox; the fields live under "More settings". */
  function waitWords(n: number | null): string {
    if (n === null || !Number.isFinite(n)) return "after the waiting time";
    return n === 0 ? "right away" : `after ${n} hour${n === 1 ? "" : "s"}`;
  }

  const summary = $derived(autoUpdateSummary(policy));
  const pause = $derived(pauseSummary(policy));
  const emailMissing = $derived(
    scheduler.notifications.some((n) => n.deliveryStatus === "no_transport"),
  );

  function when(iso: string | null): string {
    return iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "";
  }
</script>

<Card data-testid="auto-update-policy">
  <CardHeader>
    <CardTitle class="text-base">Automatic updates</CardTitle>
    <CardDescription>
      Caelo can install updates on its own once they have been out for a while; updates that change
      your Google Cloud project or cannot be undone always wait for you.
    </CardDescription>
  </CardHeader>
  <CardContent class="space-y-4 text-sm">
    <ul class="list-disc space-y-1 pl-5" data-testid="auto-update-summary">
      {#each summary as line (line)}
        <li>{line}</li>
      {/each}
    </ul>

    {#if pause}
      <Alert variant={policy.pausedByOwner ? "default" : "destructive"} data-testid="auto-update-paused">
        <AlertTitle>{pause.title}</AlertTitle>
        <AlertDescription>{pause.detail}</AlertDescription>
      </Alert>
    {/if}

    {#if scheduler.lastRunAt}
      <div class="rounded-md bg-muted p-3" data-testid="auto-update-status">
        <p class="font-medium">
          Last check {when(scheduler.lastRunAt)}{scheduler.lastVersion
            ? ` — v${scheduler.lastVersion}`
            : ""}: {scheduler.lastAction ? SCHEDULER_ACTION_LABELS[scheduler.lastAction] : ""}
        </p>
        {#if scheduler.lastReason}
          <p class="text-muted-foreground">{scheduler.lastReason}</p>
        {/if}
      </div>
    {/if}

    {#if emailMissing}
      <Alert data-testid="update-email-missing">
        <AlertTitle>Update emails are not being sent</AlertTitle>
        <AlertDescription>
          No email service is set up, so the update emails below were only recorded here. Set one
          up at <a href="/settings/email" class="underline underline-offset-4">Settings → Email</a>.
        </AlertDescription>
      </Alert>
    {/if}

    {#if scheduler.notifications.length > 0}
      <div class="space-y-1">
        <p class="font-medium">Update emails</p>
        <ul class="divide-y" data-testid="update-emails">
          {#each scheduler.notifications as n (n.id)}
            <li class="flex flex-wrap items-center gap-2 py-1.5">
              <span class="font-mono text-xs text-muted-foreground">{n.createdAt.slice(0, 10)}</span>
              <span>{n.subject}</span>
              <Badge variant={DELIVERY_DISPLAY[n.deliveryStatus].tone}>
                {DELIVERY_DISPLAY[n.deliveryStatus].label}
              </Badge>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if canEdit}
      {#if !upgraderAvailable}
        <p class="text-muted-foreground" data-testid="policy-needs-upgrader">
          These settings can be changed once this install can install updates itself (see above);
          until then Caelo only tells you about new releases.
        </p>
      {:else}
        {#if policy.paused}
          <form id="resume-form" method="post" action="?/resume" use:enhance={submitInPlace}>
            <input type="hidden" name="_csrf" value={csrfToken} />
            <Button
              type="button"
              variant="outline"
              data-testid="resume-auto-updates"
              onclick={() => (confirming = "resume")}
            >
              Resume automatic updates…
            </Button>
          </form>
        {/if}

        <!-- One choice: notify only, or install automatically. The kinds sit
             under "Install automatically" and are hidden (not removed, not
             disabled) otherwise, so saving "Notify only" keeps the ticked
             kinds as they were instead of submitting them as off. -->
        <form
          id="policy-form"
          method="post"
          action="?/savePolicy"
          use:enhance={submitInPlace}
          class="space-y-3 rounded-md border p-4"
          data-testid="policy-form"
        >
          <input type="hidden" name="_csrf" value={csrfToken} />
          <fieldset class="space-y-3">
            <legend class="sr-only">When a new Caelo release comes out</legend>
            <label class="flex items-start gap-2">
              <input
                type="radio"
                name="mode"
                value="notify"
                bind:group={mode}
                class="mt-1"
                data-testid="policy-mode-notify"
              />
              <span>
                <span class="font-medium">Notify only</span>
                <span class="block text-muted-foreground">
                  You get an email about every new release, security fixes included, and install it
                  yourself.
                </span>
              </span>
            </label>
            <label class="flex items-start gap-2">
              <input
                type="radio"
                name="mode"
                value="auto"
                bind:group={mode}
                class="mt-1"
                data-testid="policy-mode-auto"
              />
              <span>
                <span class="font-medium">Install automatically</span>
                <span class="block text-muted-foreground">
                  After a waiting time, and only these kinds:
                </span>
              </span>
            </label>
            <div class={cn("space-y-2 pl-6", mode !== "auto" && "hidden")} data-testid="policy-auto-kinds">
              <label class="flex items-start gap-2">
                <input type="checkbox" name="autoSecurity" checked={policy.autoSecurity} class="mt-1" data-testid="policy-auto-security" />
                <span>Security fixes <span class="text-muted-foreground">({waitWords(securitySoakHours)})</span></span>
              </label>
              <label class="flex items-start gap-2">
                <input type="checkbox" name="autoPatch" checked={policy.autoPatch} class="mt-1" data-testid="policy-auto-patch" />
                <span>
                  Bug fixes, for example 0.10.52 → 0.10.53
                  <span class="text-muted-foreground">({waitWords(soakHours)})</span>
                </span>
              </label>
              <label class="flex items-start gap-2">
                <input type="checkbox" name="autoMinor" checked={policy.autoMinor} class="mt-1" data-testid="policy-auto-minor" />
                <span>
                  New features, for example 0.10 → 0.11
                  <span class="text-muted-foreground">({waitWords(soakHours)})</span>
                </span>
              </label>
              <label class="flex items-start gap-2">
                <input type="checkbox" name="autoConverge" checked={policy.autoConverge} class="mt-1" data-testid="policy-auto-converge" />
                <span>
                  Updates that change your Google Cloud project
                  <span class="block text-xs text-muted-foreground" data-testid="policy-auto-converge-hint">
                    Only the kinds ticked above, after the same wait. If this site cannot make such changes itself, you are told and install them yourself.
                  </span>
                </span>
              </label>
              <p class="text-xs text-muted-foreground">
                Major releases are never installed automatically before Caelo 1.0.
              </p>
            </div>
          </fieldset>
        </form>

        <details class="rounded-md border p-4" data-testid="policy-more-settings">
          <summary class="cursor-pointer font-medium">
            More settings: maintenance window, waiting times, pause
          </summary>
          <div class="mt-4 space-y-4">
            <!-- Outside the policy <form> (the pause form below cannot nest
                 in it), so these fields join it through the form attribute. -->
            <div class="space-y-2">
              <label class="flex items-center gap-2">
                <input
                  type="checkbox"
                  form="policy-form"
                  name="windowEnabled"
                  bind:checked={windowOn}
                  data-testid="policy-window-enabled"
                />
                <span class="font-medium">Only during a maintenance window</span>
              </label>
              {#if windowOn}
                <div class="flex flex-wrap items-end gap-3">
                  <div class="space-y-1">
                    <Label for="policy-window-start">From</Label>
                    <Input id="policy-window-start" form="policy-form" type="time" name="windowStart" value={policy.windowStart ?? "02:00"} />
                  </div>
                  <div class="space-y-1">
                    <Label for="policy-window-end">To</Label>
                    <Input id="policy-window-end" form="policy-form" type="time" name="windowEnd" value={policy.windowEnd ?? "05:00"} />
                  </div>
                </div>
              {/if}
              <div class="space-y-1">
                <Label for="policy-timezone">Time zone</Label>
                <Input id="policy-timezone" form="policy-form" name="windowTimezone" value={policy.windowTimezone} />
                <p class="text-xs text-muted-foreground">For example Europe/Berlin or America/New_York.</p>
              </div>
            </div>

            <div class="space-y-1">
              <div class="flex flex-wrap gap-3">
                <div class="space-y-1">
                  <Label for="policy-soak">Wait after a release (hours)</Label>
                  <Input
                    id="policy-soak"
                    form="policy-form"
                    type="number"
                    min="0"
                    max="720"
                    name="soakHours"
                    bind:value={soakHours}
                    class="w-32"
                  />
                </div>
                <div class="space-y-1">
                  <Label for="policy-security-soak">Wait for security fixes (hours)</Label>
                  <Input
                    id="policy-security-soak"
                    form="policy-form"
                    type="number"
                    min="0"
                    max="720"
                    name="securitySoakHours"
                    bind:value={securitySoakHours}
                    class="w-32"
                  />
                </div>
              </div>
              <p class="text-xs text-muted-foreground">
                Waiting lets problems with a new release surface before it reaches your site.
                Security fixes wait less, because the problem they fix is public.
              </p>
            </div>

            {#if !policy.paused}
              <div class="border-t pt-4">
                <form
                  id="pause-form"
                  method="post"
                  action="?/pause"
                  use:enhance={submitInPlace}
                  class="flex flex-wrap items-end gap-3"
                  data-testid="pause-form"
                >
                  <input type="hidden" name="_csrf" value={csrfToken} />
                  <div class="space-y-1">
                    <Label for="pause-for">Pause automatic updates</Label>
                    <Select id="pause-for" name="pauseFor" value="7">
                      <option value="1">for 1 day</option>
                      <option value="3">for 3 days</option>
                      <option value="7">for 1 week</option>
                      <option value="14">for 2 weeks</option>
                      <option value="30">for 30 days</option>
                      <option value="resume">until I resume them</option>
                    </Select>
                  </div>
                  <div class="min-w-48 flex-1 space-y-1">
                    <Label for="pause-reason">Why (optional)</Label>
                    <Input id="pause-reason" name="reason" maxlength={500} placeholder="e.g. launch week" />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    data-testid="pause-auto-updates"
                    onclick={() => (confirming = "pause")}
                  >
                    Pause…
                  </Button>
                </form>
              </div>
            {/if}
          </div>
        </details>

        <Button type="button" data-testid="save-policy" onclick={() => (confirming = "savePolicy")}>
          Save…
        </Button>
        <p class="text-xs text-muted-foreground">Each change asks for your password.</p>
        {#if confirming}
          <PasswordConfirmDialog
            bind:open={() => confirming !== null, (v) => { if (!v) confirming = null; }}
            formId={FORM_IDS[confirming]}
            title={TITLES[confirming]}
            submitLabel="Confirm"
            error={failedAction === confirming ? error : null}
            testid="policy-dialog"
          />
        {/if}
      {/if}
      {#if error && !isPolicyAction(failedAction)}
        <p class="text-sm text-destructive" data-testid="policy-error">{error}</p>
      {/if}
    {/if}
  </CardContent>
</Card>
