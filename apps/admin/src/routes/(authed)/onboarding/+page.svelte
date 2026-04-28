<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { ArrowRight, Rocket, Sparkles, Users, Wand2 } from "lucide-svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { buttonVariants } from "$lib/components/ui/button/button-variants.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";

  let { data } = $props();

  let step = $state(0);
  const steps = [
    {
      icon: Sparkles,
      title: "Welcome to Caelo",
      body:
        "Caelo is an AI-first CMS. The AI on the right edits your live pages — try it from the Live edit surface. Everything else (deploys, users, settings) lives in the sidebar.",
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
  // Step is bounded to `0..steps.length-1` by the Back/Next handlers,
  // so `steps[step]` is always defined; the non-null assertion keeps
  // the template terse without {#if} guards everywhere.
  const current = $derived(steps[step]!);
  const isLast = $derived(step === steps.length - 1);
</script>

<div class="mx-auto flex min-h-[60vh] max-w-2xl items-center">
  <Card class="w-full">
    <CardHeader class="text-center">
      <div class="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10">
        <current.icon class="size-6 text-primary" aria-hidden="true" />
      </div>
      <CardTitle class="text-2xl">{current.title}</CardTitle>
      <CardDescription class="mt-2 text-base">{current.body}</CardDescription>
    </CardHeader>
    <CardContent class="space-y-6">
      <div class="flex items-center justify-center gap-1.5" aria-label="Progress">
        {#each steps as _, i}
          <span
            class={`block h-1.5 rounded-full transition-all motion-reduce:transition-none ${i === step ? "w-6 bg-primary" : i < step ? "w-3 bg-primary/60" : "w-3 bg-muted"}`}
            aria-hidden="true"
          ></span>
        {/each}
      </div>

      {#if current.action}
        <div class="flex justify-center">
          <a
            href={current.action.href}
            class={buttonVariants({ variant: "outline" })}
            target="_blank"
            rel="noopener"
          >
            {current.action.label}
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
      {:else}
        <form method="post" action="?/complete" class="text-center">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <button
            type="submit"
            class="text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            Skip and finish
          </button>
        </form>
      {/if}
    </CardContent>
  </Card>
</div>
