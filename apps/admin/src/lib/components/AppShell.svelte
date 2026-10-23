<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { page } from "$app/state";
  import {
    ChevronDown,
    FileText,
    GitPullRequestArrow,
    Image as ImageIcon,
    Layers,
    Layout,
    LayoutDashboard,
    LogOut,
    Moon,
    Package,
    Palette,
    Settings,
    Sun,
    Type,
    UserCog,
    Wand2,
  } from "lucide-svelte";
  import { onMount } from "svelte";
  import { CAELO_VERSION } from "@caelo-cms/shared";
  import { mode, toggleMode } from "mode-watcher";
  const isDark = $derived(mode.current === "dark");
  import CaeloMark from "#lib/components/CaeloMark.svelte";
  import NotificationBell from "#lib/components/NotificationBell.svelte";
  import RunningAgentsIndicator from "#lib/components/agents/RunningAgentsIndicator.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Separator } from "#lib/components/ui/separator/index.js";
  import {
    activeNavHref,
    CONTENT_GROUP_ID,
    CONTENT_GROUP_LABEL,
    type MainNavIcon,
    visibleMainNav,
  } from "#lib/main-nav.js";
  import { hasAnySettingsAccess, settingsCrumbLabel } from "#lib/settings-nav.js";
  import { cn } from "#lib/utils.js";

  interface Props {
    permissions: string[];
    csrfToken: string;
    userEmail?: string | null;
    /** Live "AI spend — last 7 days" readout for the top bar; null hides it. */
    aiSpend7d?: { display: string; costMicrocents: number; days: number } | null;
    children?: import("svelte").Snippet;
  }
  let {
    permissions,
    csrfToken,
    userEmail = null,
    aiSpend7d = null,
    children,
  }: Props = $props();

  const ICONS: Record<MainNavIcon, typeof LayoutDashboard> = {
    dashboard: LayoutDashboard,
    wand: Wand2,
    settings: Settings,
    content: Package,
    changes: GitPullRequestArrow,
    file: FileText,
    layers: Layers,
    package: Package,
    image: ImageIcon,
    layout: Layout,
    palette: Palette,
    type: Type,
  };

  const nav = $derived(visibleMainNav(permissions, hasAnySettingsAccess(permissions)));
  const activeHref = $derived(
    activeNavHref(page.url.pathname, [
      ...(nav.liveEdit ? [nav.liveEdit.href] : []),
      nav.dashboard.href,
      ...nav.content.map((l) => l.href),
      ...(nav.settings ? [nav.settings.href] : []),
      "/account",
    ]),
  );

  // The Content group starts open (server render and first paint agree);
  // a viewer who collapses it keeps it collapsed. Storage can be missing
  // or throw (private windows), so the toggle still works without it.
  const CONTENT_GROUP_STORAGE_KEY = `caelo:nav-group:${CONTENT_GROUP_ID}`;
  let contentOpen = $state(true);
  onMount(() => {
    try {
      if (localStorage.getItem(CONTENT_GROUP_STORAGE_KEY) === "closed") contentOpen = false;
    } catch {
      // Storage unavailable: keep the default.
    }
  });
  function toggleContent() {
    contentOpen = !contentOpen;
    try {
      localStorage.setItem(CONTENT_GROUP_STORAGE_KEY, contentOpen ? "open" : "closed");
    } catch {
      // Storage unavailable: the choice lasts for this page view only.
    }
  }
  // A collapsed group still opens when the viewer is on one of its pages,
  // so the highlighted entry is never hidden.
  const contentExpanded = $derived(
    contentOpen || nav.content.some((l) => l.href === activeHref),
  );

  const linkClass = (active: boolean) =>
    cn(
      "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors motion-reduce:transition-none",
      active
        ? "bg-accent text-accent-foreground"
        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
    );

  /**
   * Breadcrumb trail derived from the URL. Each segment is a `(href,
   * label)` pair so every step is clickable and can return the user to
   * the parent list. UUID segments collapse into the previous label
   * ("Pages / <uuid>" → just "Pages → <last-known-label>"). Entity-name
   * resolution (page slug instead of "Page") is P6.6 polish.
   */
  const breadcrumbCrumbs = $derived(
    (() => {
      const parts = page.url.pathname.split("/").filter((s) => s.length > 0);
      const out: { href: string; label: string }[] = [];
      let acc = "";
      for (const part of parts) {
        acc += `/${part}`;
        if (part.match(/^[0-9a-f-]{36}$/)) continue; // skip UUIDs
        out.push({
          href: acc,
          // Settings pages carry their operator-facing name from the nav
          // model ("AI provider & models", not "Ai").
          label:
            settingsCrumbLabel(acc) ??
            part.charAt(0).toUpperCase() + part.slice(1).replace(/-/g, " "),
        });
      }
      return out;
    })(),
  );
</script>

{#snippet navIcon(key: MainNavIcon)}
  {@const Icon = ICONS[key]}
  <Icon class="size-4" />
{/snippet}

<div class="flex min-h-screen w-full">
  <aside class="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-card md:flex">
    <div class="flex h-14 items-center border-b px-4">
      <a href="/" class="flex items-center gap-2 font-semibold" aria-label="Caelo CMS — Dashboard">
        <CaeloMark variant="open" size={28} />
        <span class="text-base tracking-tight">Caelo</span>
      </a>
    </div>
    {#if nav.liveEdit}
      <a
        href={nav.liveEdit.href}
        aria-current={activeHref === nav.liveEdit.href ? "page" : undefined}
        data-testid="nav-live-edit"
        class={cn(
          "mx-2 mt-4 flex flex-col gap-0.5 rounded-md bg-primary px-3 py-2.5 text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 motion-reduce:transition-none",
          activeHref === nav.liveEdit.href && "ring-2 ring-ring ring-offset-2 ring-offset-card",
        )}
      >
        <span class="flex items-center gap-3 text-sm font-semibold">
          {@render navIcon(nav.liveEdit.icon)}
          {nav.liveEdit.label}
        </span>
        <span class="pl-7 text-xs text-primary-foreground/80">{nav.liveEdit.description}</span>
      </a>
    {/if}
    <nav aria-label="Main navigation" class="flex-1 space-y-1 overflow-y-auto px-2 py-4">
      <a
        href={nav.dashboard.href}
        aria-current={activeHref === nav.dashboard.href ? "page" : undefined}
        class={linkClass(activeHref === nav.dashboard.href)}
      >
        {@render navIcon(nav.dashboard.icon)}
        {nav.dashboard.label}
      </a>
      {#if nav.content.length > 0}
        <button
          type="button"
          class="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground motion-reduce:transition-none"
          aria-expanded={contentExpanded}
          aria-controls="nav-group-{CONTENT_GROUP_ID}"
          onclick={toggleContent}
        >
          {@render navIcon("content")}
          {CONTENT_GROUP_LABEL}
          <ChevronDown
            class={cn(
              "ml-auto size-4 transition-transform motion-reduce:transition-none",
              !contentExpanded && "-rotate-90",
            )}
          />
        </button>
        <div id="nav-group-{CONTENT_GROUP_ID}" class="space-y-1 pl-4" hidden={!contentExpanded}>
          {#each nav.content as item (item.href)}
            <a
              href={item.href}
              aria-current={activeHref === item.href ? "page" : undefined}
              class={linkClass(activeHref === item.href)}
            >
              {@render navIcon(item.icon)}
              {item.label}
            </a>
          {/each}
        </div>
      {/if}
      {#if nav.settings}
        <a
          href={nav.settings.href}
          aria-current={activeHref === nav.settings.href ? "page" : undefined}
          class={linkClass(activeHref === nav.settings.href)}
        >
          {@render navIcon(nav.settings.icon)}
          {nav.settings.label}
        </a>
      {/if}
    </nav>
    <Separator />
    <div class="flex flex-col gap-1 p-2 text-sm">
      {#if userEmail}
        <p class="truncate px-3 py-1 text-xs text-muted-foreground" title={userEmail}>
          {userEmail}
        </p>
      {/if}
      <p class="px-3 py-1 text-[10px] text-muted-foreground" title="Caelo CMS version">
        v{CAELO_VERSION}
      </p>
      <!-- Personal account (change your own password) — every signed-in user. -->
      <a
        href="/account"
        aria-current={activeHref === "/account" ? "page" : undefined}
        class={linkClass(activeHref === "/account")}
      >
        <UserCog class="size-4" /> Account
      </a>
      <form method="post" action="/logout">
        <input type="hidden" name="_csrf" value={csrfToken} />
        <Button variant="ghost" size="sm" type="submit" class="w-full justify-start gap-3">
          <LogOut class="size-4" /> Log out
        </Button>
      </form>
    </div>
  </aside>

  <div class="flex w-full flex-1 flex-col">
    <header
      class="sticky top-0 z-30 flex h-14 items-center gap-4 border-b bg-background/95 px-4 backdrop-blur md:px-6"
    >
      <nav aria-label="Breadcrumb" class="flex items-center gap-2 text-sm">
        {#if breadcrumbCrumbs.length === 0}
          <span class="font-medium">Dashboard</span>
        {:else}
          {#each breadcrumbCrumbs as crumb, i (crumb.href)}
            {#if i > 0}<span class="text-muted-foreground">/</span>{/if}
            {#if i === breadcrumbCrumbs.length - 1}
              <span class="font-medium">{crumb.label}</span>
            {:else}
              <a
                href={crumb.href}
                class="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >{crumb.label}</a
              >
            {/if}
          {/each}
        {/if}
      </nav>
      <div class="ml-auto flex items-center gap-2">
        {#if aiSpend7d}
          <span class="text-xs text-muted-foreground" title="AI spend, last 7 days">
            AI · {aiSpend7d.display} / 7d
          </span>
        {/if}
        <RunningAgentsIndicator {csrfToken} />
        <NotificationBell />
        <Button variant="ghost" size="icon" aria-label="Toggle theme" onclick={toggleMode}>
          {#if isDark}
            <Sun class="size-4" />
          {:else}
            <Moon class="size-4" />
          {/if}
        </Button>
      </div>
    </header>
    <main class="flex-1">
      <div class="mx-auto w-full max-w-7xl px-4 py-6 md:px-6 md:py-8">
        {@render children?.()}
      </div>
    </main>
  </div>
</div>
