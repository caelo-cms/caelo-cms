<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { page } from "$app/state";
  import {
    FileText,
    Layers,
    Layout,
    LayoutDashboard,
    LogOut,
    MessageSquare,
    Moon,
    Rocket,
    ShieldCheck,
    Sun,
    Wand2,
  } from "lucide-svelte";
  import { mode, toggleMode } from "mode-watcher";
  const isDark = $derived(mode.current === "dark");
  import { Button } from "$lib/components/ui/button/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import { cn } from "$lib/utils.js";

  interface Props {
    permissions: string[];
    csrfToken: string;
    userEmail?: string | null;
    children?: import("svelte").Snippet;
  }
  let {
    permissions,
    csrfToken,
    userEmail = null,
    children,
  }: Props = $props();

  const has = (p: string) => permissions.includes(p);
  const navItems = $derived(
    [
      { href: "/", label: "Dashboard", icon: LayoutDashboard, show: true },
      { href: "/edit", label: "Live edit", icon: Wand2, show: has("content.write") },
      { href: "/content/pages", label: "Pages", icon: FileText, show: has("content.read") },
      { href: "/content/modules", label: "Modules", icon: Layers, show: has("content.read") },
      {
        href: "/content/templates",
        label: "Templates",
        icon: Layout,
        show: has("content.read"),
      },
      { href: "/content/chat", label: "Chats", icon: MessageSquare, show: has("content.write") },
      {
        href: "/security/deployments",
        label: "Deployments",
        icon: Rocket,
        show: has("ops.view"),
      },
      { href: "/security", label: "Security", icon: ShieldCheck, show: has("settings.read") },
    ].filter((i) => i.show),
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
          label: part.charAt(0).toUpperCase() + part.slice(1).replace(/-/g, " "),
        });
      }
      return out;
    })(),
  );
</script>

<div class="flex min-h-screen w-full">
  <aside class="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-card md:flex">
    <div class="flex h-14 items-center border-b px-4">
      <a href="/" class="flex items-center gap-2 font-semibold" aria-label="Caelo CMS — Dashboard">
        <span
          class="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground"
          aria-hidden="true"
        >
          C
        </span>
        <span class="text-base tracking-tight">Caelo</span>
      </a>
    </div>
    <nav aria-label="Main navigation" class="flex-1 space-y-1 px-2 py-4">
      {#each navItems as item (item.href)}
        {@const Active =
          page.url.pathname === item.href ||
          (item.href !== "/" && page.url.pathname.startsWith(`${item.href}/`))}
        <a
          href={item.href}
          class={cn(
            "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors motion-reduce:transition-none",
            Active
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          )}
        >
          <item.icon class="size-4" />
          {item.label}
        </a>
      {/each}
    </nav>
    <Separator />
    <div class="flex flex-col gap-1 p-2 text-sm">
      {#if userEmail}
        <p class="truncate px-3 py-1 text-xs text-muted-foreground" title={userEmail}>
          {userEmail}
        </p>
      {/if}
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
