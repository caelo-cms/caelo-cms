<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { FileText, Layers, Layout, MessageSquare, Rocket, Sailboat, ShieldCheck } from "lucide-svelte";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";

  let { data } = $props();
  const has = (p: string) => data.user.permissions.includes(p);

  const tiles = $derived(
    [
      { href: "/content/pages", label: "Pages", desc: "Compose pages from modules", icon: FileText, show: has("content.read") },
      { href: "/content/modules", label: "Modules", desc: "HTML / CSS / JS building blocks", icon: Layers, show: has("content.read") },
      { href: "/content/templates", label: "Templates", desc: "Page skeletons with named slots", icon: Layout, show: has("content.read") },
      { href: "/content/chat", label: "Chats", desc: "Edit by talking to the AI", icon: MessageSquare, show: has("content.write") },
      { href: "/security/deployments", label: "Deployments", desc: "Stage / promote / rollback", icon: Rocket, show: has("ops.view") },
      { href: "/security", label: "Security", desc: "Users, roles, AI provider, costs", icon: ShieldCheck, show: has("settings.read") },
    ].filter((t) => t.show),
  );

  // P19 — when there are no published pages, surface "Ramp up" as the
  // primary CTA at the top of the dashboard. After first publish the
  // banner disappears and the sidebar entry remains for re-runs.
  const showRampUpHero = $derived(
    has("settings.write") && (data.publishedPageCount ?? 0) === 0,
  );
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Welcome back</h1>
    <p class="text-sm text-muted-foreground">Signed in as <strong>{data.user.email}</strong></p>
  </div>

  <!-- issue #187 — the chat is the front door: this hero routes to /edit,
       whose first-run welcome offers migrate / from-scratch / own-design.
       The /ramp-up wizard stays in the sidebar as the fallback surface. -->
  {#if showRampUpHero}
    <a href="/edit" class="block">
      <Card class="border-primary/40 bg-primary/5 transition-colors hover:bg-primary/10">
        <CardHeader>
          <CardTitle class="flex items-center gap-2 text-base">
            <Sailboat class="size-5" />
            Set up your site
          </CardTitle>
          <CardDescription>
            Open the chat and tell the AI where to start — migrate an existing website, build from
            scratch, or bring your own design. You answer questions and approve the big steps; the
            AI does the work. Recommended first step for new installs.
          </CardDescription>
        </CardHeader>
      </Card>
    </a>
  {/if}

  <div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
    {#each tiles as tile (tile.href)}
      <a href={tile.href} class="block">
        <Card class="transition-colors hover:bg-accent">
          <CardHeader>
            <CardTitle class="flex items-center gap-2 text-base">
              <tile.icon class="size-4" />
              {tile.label}
            </CardTitle>
            <CardDescription>{tile.desc}</CardDescription>
          </CardHeader>
        </Card>
      </a>
    {/each}
  </div>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Roles &amp; permissions</CardTitle>
    </CardHeader>
    <CardContent class="space-y-1 text-sm text-muted-foreground">
      <p><span class="font-medium text-foreground">Roles:</span> {data.user.roles.join(", ")}</p>
      <p>
        <span class="font-medium text-foreground">Permissions:</span>
        {data.user.permissions.join(", ")}
      </p>
    </CardContent>
  </Card>
</div>
