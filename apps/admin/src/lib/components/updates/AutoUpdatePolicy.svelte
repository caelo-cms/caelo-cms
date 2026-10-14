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
  import { enhance, type SubmitFunction } from "$app/forms";
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
  import PasswordConfirmDialog from "./PasswordConfirmDialog.svelte";
  import {
    autoUpdateSummary,
    DELIVERY_DISPLAY,
    pauseSummary,
    SCHEDULER_ACTION_LABELS,
  } from "#lib/auto-update-display.js";

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
   * closes once the change went through.
   */
  const submitInPlace: SubmitFunction = () => async ({ result, update }) => {
    await update({ reset: false });
    if (result.type === "success") confirming = null;
  };

  // svelte-ignore state_referenced_locally
  let mode = $state(policy.mode);
  // svelte-ignore state_referenced_locally
  let windowOn = $state(policy.windowStart !== null);

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
      Caelo can install some updates on its own, after they have been out for a while and only when
      you allow it. Releases that change your cloud setup or make destructive database changes are
      never installed on their own — you get an email instead.
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
        <form
          id="policy-form"
          method="post"
          action="?/savePolicy"
          use:enhance={submitInPlace}
          class="space-y-4 rounded-md border p-4"
          data-testid="policy-form"
        >
          <input type="hidden" name="_csrf" value={csrfToken} />
          <div class="space-y-1">
            <Label for="policy-mode">When a new Caelo release comes out</Label>
            <Select id="policy-mode" name="mode" bind:value={mode}>
              <option value="off">Don't tell me</option>
              <option value="notify">Tell me; I install it myself</option>
              <option value="auto">Install the kinds I choose automatically</option>
            </Select>
          </div>

          <!-- The choices stay editable and submitted in every mode (a disabled
               fieldset would save them as off), so this says when they apply
               instead of fading them below WCAG contrast. -->
          <fieldset class="space-y-2">
            <legend class="font-medium">Install automatically</legend>
            {#if mode !== "auto"}
              <p class="text-xs text-muted-foreground" data-testid="policy-auto-inactive">
                Used only when the setting above is "Install the kinds I choose automatically".
              </p>
            {/if}
            <label class="flex items-start gap-2">
              <input type="checkbox" name="autoSecurity" checked={policy.autoSecurity} data-testid="policy-auto-security" />
              <span>Security fixes — releases that fix a published security advisory</span>
            </label>
            <label class="flex items-start gap-2">
              <input type="checkbox" name="autoPatch" checked={policy.autoPatch} data-testid="policy-auto-patch" />
              <span>Patch releases — bug fixes (for example 0.10.47 → 0.10.48)</span>
            </label>
            <label class="flex items-start gap-2">
              <input type="checkbox" name="autoMinor" checked={policy.autoMinor} data-testid="policy-auto-minor" />
              <span>Minor releases — new features (for example 0.10 → 0.11)</span>
            </label>
            <p class="text-xs text-muted-foreground">
              Major releases are never installed automatically before Caelo 1.0.
            </p>
          </fieldset>

          <div class="space-y-2">
            <label class="flex items-center gap-2">
              <input type="checkbox" name="windowEnabled" bind:checked={windowOn} data-testid="policy-window-enabled" />
              <span class="font-medium">Only during a maintenance window</span>
            </label>
            {#if windowOn}
              <div class="flex flex-wrap items-end gap-3">
                <div class="space-y-1">
                  <Label for="policy-window-start">From</Label>
                  <Input id="policy-window-start" type="time" name="windowStart" value={policy.windowStart ?? "02:00"} />
                </div>
                <div class="space-y-1">
                  <Label for="policy-window-end">To</Label>
                  <Input id="policy-window-end" type="time" name="windowEnd" value={policy.windowEnd ?? "05:00"} />
                </div>
              </div>
            {/if}
            <div class="space-y-1">
              <Label for="policy-timezone">Time zone</Label>
              <Input id="policy-timezone" name="windowTimezone" value={policy.windowTimezone} />
              <p class="text-xs text-muted-foreground">For example Europe/Berlin or America/New_York.</p>
            </div>
          </div>

          <div class="flex flex-wrap gap-3">
            <div class="space-y-1">
              <Label for="policy-soak">Wait after a release (hours)</Label>
              <Input id="policy-soak" type="number" min="0" max="720" name="soakHours" value={policy.soakHours} class="w-32" />
            </div>
            <div class="space-y-1">
              <Label for="policy-security-soak">Wait for security fixes (hours)</Label>
              <Input
                id="policy-security-soak"
                type="number"
                min="0"
                max="720"
                name="securitySoakHours"
                value={policy.securitySoakHours}
                class="w-32"
              />
            </div>
          </div>
          <p class="text-xs text-muted-foreground">
            Waiting lets problems with a new release surface before it reaches your site. Security
            fixes wait less, because the problem they fix is public.
          </p>
          <Button type="button" data-testid="save-policy" onclick={() => (confirming = "savePolicy")}>
            Save…
          </Button>
        </form>

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
        {:else}
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
        {/if}
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
