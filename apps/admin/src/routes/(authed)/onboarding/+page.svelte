<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  // v0.11.4 (issue #76 follow-up) — onboarding now starts with a "Tell
  // us about your site" step that captures siteName + sitePurpose +
  // optional brandColor. On submit, the server writes site_defaults +
  // updates the active theme (display name, description, primary
  // color). This is what flips the theme's origin from 'seed' to
  // 'operator' BEFORE any chat turn runs — so the AI sees a real
  // brand context from turn 1.
  import { enhance } from "$app/forms";
  import { ArrowRight, Palette, Rocket, Sparkles, Users, Wand2 } from "lucide-svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { buttonVariants } from "$lib/components/ui/button/button-variants.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";

  let { data, form } = $props();

  // The identity step is index 0; tour steps follow. The identity step
  // does NOT count toward the visible "Next" progression UI on the
  // same control set — it has its own form-submit "Save & continue"
  // button.
  let step = $state(0);

  // Pre-fill from saved data (operators who revisit /onboarding) OR
  // the action's returned form values (post-fail re-render).
  let siteName = $state(form?.siteName ?? data.siteName ?? "");
  let sitePurpose = $state(form?.sitePurpose ?? data.sitePurpose ?? "");
  let brandColor = $state(form?.brandColor ?? "");
  let identitySaving = $state(false);

  const tourSteps = [
    {
      icon: Sparkles,
      title: "Welcome to Caelo",
      body:
        "The AI on the right edits your live pages — try it from the Live edit surface. Everything else (deploys, users, settings) lives in the sidebar.",
    },
    {
      icon: Wand2,
      title: "Edit your first page",
      body:
        "Open Live edit and ask the AI to change something — 'add a hero with the headline Welcome to my site'. Changes preview live before you publish.",
      action: { href: "/edit", label: "Open Live edit" },
    },
    {
      icon: Users,
      title: "Invite a collaborator",
      body:
        "Add other admins from Security → Users. Built-in roles (Owner, Editor, Reviewer) cover most cases; create custom roles when you need narrower scope.",
      action: { href: "/security/users", label: "Manage users" },
    },
    {
      icon: Rocket,
      title: "Set up deployments",
      body:
        "When the site's ready, build staging from the Deployments panel and promote to production. Both environments are isolated; staging is noindex by default.",
      action: { href: "/security/deployments", label: "Open deployments" },
    },
  ];

  // step 0 = identity form; step 1..N = tour steps mapped to tourSteps[step - 1].
  const totalSteps = $derived(tourSteps.length + 1);
  const isIdentityStep = $derived(step === 0);
  const tourIndex = $derived(step - 1);
  const currentTour = $derived(tourIndex >= 0 ? tourSteps[tourIndex] : null);
  const isLast = $derived(step === totalSteps - 1);
</script>

<div class="mx-auto flex min-h-[60vh] max-w-2xl items-center">
  <Card class="w-full">
    {#if isIdentityStep}
      <CardHeader class="text-center">
        <div
          class="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10"
        >
          <Palette class="size-6 text-primary" aria-hidden="true" />
        </div>
        <CardTitle class="text-2xl">Tell us about your site</CardTitle>
        <CardDescription class="mt-2 text-base">
          One step to set up your brand. The AI uses this for every page it builds —
          without it, your site renders with neutral defaults.
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-6">
        <form
          method="post"
          action="?/identity"
          use:enhance={() => {
            identitySaving = true;
            return async ({ result, update }) => {
              identitySaving = false;
              await update({ reset: false });
              // On success, advance to the next step (Welcome tour).
              if (result.type === "success") step = 1;
            };
          }}
          class="space-y-4"
        >
          <input type="hidden" name="_csrf" value={data.csrfToken} />

          <div class="grid gap-1.5">
            <Label for="siteName">Site name <span class="text-destructive">*</span></Label>
            <Input
              id="siteName"
              name="siteName"
              type="text"
              bind:value={siteName}
              placeholder="Acme Sustainability Consulting"
              maxlength={200}
              required
              autocomplete="off"
            />
            <p class="text-xs text-muted-foreground">
              Used in the header + as your theme name.
            </p>
          </div>

          <div class="grid gap-1.5">
            <Label for="sitePurpose">What's this site for?</Label>
            <textarea
              id="sitePurpose"
              name="sitePurpose"
              bind:value={sitePurpose}
              placeholder="A consulting firm helping mid-sized companies cut carbon emissions. We want a professional, calm, trustworthy feel."
              maxlength={2000}
              rows={4}
              class="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
            ></textarea>
            <p class="text-xs text-muted-foreground">
              One or two sentences. The AI uses this to pick fitting colors, copy,
              and module layouts.
            </p>
          </div>

          <div class="grid gap-1.5">
            <Label for="brandColor">Brand color <span class="text-muted-foreground">(optional)</span></Label>
            <div class="flex items-center gap-2">
              <input
                id="brandColor"
                name="brandColor"
                type="color"
                bind:value={brandColor}
                class="h-10 w-16 cursor-pointer rounded border border-input bg-transparent"
              />
              <Input
                type="text"
                bind:value={brandColor}
                placeholder="#4f46e5"
                maxlength={32}
                class="flex-1 font-mono text-sm"
              />
            </div>
            <p class="text-xs text-muted-foreground">
              Pick a primary color or leave blank for neutral defaults. Common picks:
              <code>#4f46e5</code> indigo, <code>#7c3aed</code> violet,
              <code>#06b6d4</code> cyan, <code>#10b981</code> emerald,
              <code>#f59e0b</code> amber.
            </p>
          </div>

          {#if form?.error}
            <p class="text-sm text-destructive">{form.error}</p>
          {/if}

          <div class="flex items-center justify-between gap-2 border-t pt-4">
            <span class="text-xs text-muted-foreground">Step 1 of {totalSteps}</span>
            <Button type="submit" disabled={identitySaving || !siteName.trim()}>
              {identitySaving ? "Saving…" : "Save & continue"}
              <ArrowRight class="ml-1.5 size-4" />
            </Button>
          </div>
        </form>

        <form method="post" action="?/complete" class="text-center">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <button
            type="submit"
            class="text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            Skip onboarding entirely
          </button>
        </form>
      </CardContent>
    {:else if currentTour}
      <CardHeader class="text-center">
        <div
          class="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10"
        >
          <currentTour.icon class="size-6 text-primary" aria-hidden="true" />
        </div>
        <CardTitle class="text-2xl">{currentTour.title}</CardTitle>
        <CardDescription class="mt-2 text-base">{currentTour.body}</CardDescription>
      </CardHeader>
      <CardContent class="space-y-6">
        <div class="flex items-center justify-center gap-1.5" aria-label="Progress">
          {#each Array(totalSteps) as _, i}
            <span
              class={`block h-1.5 rounded-full transition-all motion-reduce:transition-none ${i === step ? "w-6 bg-primary" : i < step ? "w-3 bg-primary/60" : "w-3 bg-muted"}`}
              aria-hidden="true"
            ></span>
          {/each}
        </div>

        {#if currentTour.action}
          <div class="flex justify-center">
            <a
              href={currentTour.action.href}
              class={buttonVariants({ variant: "outline" })}
              target="_blank"
              rel="noopener"
            >
              {currentTour.action.label}
              <ArrowRight class="ml-1.5 size-4" />
            </a>
          </div>
        {/if}

        <div class="flex items-center justify-between gap-2 border-t pt-4">
          <Button
            type="button"
            variant="ghost"
            disabled={step === 0}
            onclick={() => (step = Math.max(0, step - 1))}
          >
            Back
          </Button>
          <form method="post" action="?/complete">
            <input type="hidden" name="_csrf" value={data.csrfToken} />
            {#if !isLast}
              <Button type="button" onclick={() => (step += 1)}>Next</Button>
            {:else}
              <Button type="submit">Finish</Button>
            {/if}
          </form>
        </div>

        {#if data.alreadyOnboarded}
          <p class="text-center text-xs text-muted-foreground">
            You've already completed onboarding. <a href="/" class="underline">Return to dashboard</a>.
          </p>
        {/if}
      </CardContent>
    {/if}
  </Card>
</div>
